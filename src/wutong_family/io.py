from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional

import numpy as np
import pandas as pd


SHEETS = {
    "train": "已知家庭圈标识数据",
    "valid_unlabeled": "无标识的待验证数据",
    "test_unlabeled": "新增用户测试数据",
}


ID_COLS = ["subs_id", "call_subs_id", "acct_id", "family_net_id", "grp_offer_ins_id", "building_id", "pay_acct_id"]


def _to_id_str(x: Any) -> Optional[str]:
    """Convert id-like values to stable strings (avoids 1.0 / scientific notation)."""
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return None
    if isinstance(x, (int, np.integer)):
        return str(int(x))
    if isinstance(x, (float, np.floating)):
        # Many IDs are read as floats; convert safely when integral.
        if float(x).is_integer():
            return str(int(x))
        return str(x)
    s = str(x).strip()
    if s == "" or s.lower() == "nan":
        return None
    return s


def _drop_header_row(df: pd.DataFrame) -> pd.DataFrame:
    if "subs_id" in df.columns and len(df) > 0:
        if str(df.iloc[0]["subs_id"]).strip() in {"用户ID", "subs_id"}:
            return df.iloc[1:].reset_index(drop=True)
    return df


def read_sheet(path: str, sheet_name: str) -> pd.DataFrame:
    df = pd.read_excel(path, sheet_name=sheet_name)
    df = _drop_header_row(df)

    # Normalize id-like columns.
    for c in ID_COLS:
        if c in df.columns:
            df[c] = df[c].map(_to_id_str)

    # Normalize dates.
    if "birth_day" in df.columns:
        df["birth_day"] = pd.to_datetime(df["birth_day"], errors="coerce")
    if "statis_ymd" in df.columns:
        df["statis_ymd"] = pd.to_datetime(df["statis_ymd"], errors="coerce")

    return df


def read_all(path: str) -> Dict[str, pd.DataFrame]:
    return {k: read_sheet(path, v) for k, v in SHEETS.items()}


def derive_user_table(df_calls: pd.DataFrame) -> pd.DataFrame:
    """
    Convert call-detail rows into one row per `subs_id` with stable user attributes.
    """
    # pick representative values per user (first non-null)
    cols = [c for c in df_calls.columns if c not in {"call_subs_id", "posite_id", "statis_ymd"}]
    df_u = df_calls[cols].copy()

    def first_non_null(s: pd.Series):
        s2 = s.dropna()
        return s2.iloc[0] if len(s2) else None

    agg: Dict[str, Any] = {}
    for c in df_u.columns:
        if c == "subs_id":
            continue
        if c in {"arpu", "dou", "mou"}:
            agg[c] = "mean"
        else:
            agg[c] = first_non_null

    users = df_u.groupby("subs_id", as_index=False).agg(agg)

    # Age feature
    if "birth_day" in users.columns:
        ref = pd.Timestamp("2025-12-01")
        users["age"] = (ref - users["birth_day"]).dt.days / 365.25
        users["age"] = users["age"].fillna(users["age"].median())
    else:
        users["age"] = np.nan

    # Normalize common yes/no flags into 0/1 where possible.
    yn_cols = [
        "family_flag",
        "car_flag",
        "pet_flag",
        "abnormal_flag",
        "warn_flag",
        "low_flag",
        "main_abn_flag",
        "band_flag",
        "fttr_flag",
        "compet_flag",
        "iptv_flag",
        "iptv_vip_flag",
        "hard_flag",
        "save_flag",
        "heal_flag",
    ]
    for c in yn_cols:
        if c not in users.columns:
            continue

        def yn(v: Any) -> float:
            if v is None or (isinstance(v, float) and np.isnan(v)):
                return 0.0
            s = str(v).strip()
            if s in {"是", "1", "Y", "y", "true", "True"}:
                return 1.0
            if s in {"否", "0", "N", "n", "false", "False"}:
                return 0.0
            # unknown -> 0
            return 0.0

        users[c] = users[c].map(yn).astype("float32")

    # Fill numeric
    for c in ["arpu", "dou", "mou", "age"]:
        if c in users.columns:
            users[c] = pd.to_numeric(users[c], errors="coerce").fillna(0.0).astype("float32")

    return users


def derive_call_edges(df_calls: pd.DataFrame, universe_users: Optional[set[str]] = None) -> pd.DataFrame:
    """
    Aggregate call detail rows into directed edges (u -> v) with counts/days/base stations.
    """
    df = df_calls[["subs_id", "call_subs_id", "posite_id", "statis_ymd"]].copy()
    df = df.dropna(subset=["subs_id", "call_subs_id"])
    if universe_users is not None:
        df = df[df["subs_id"].isin(universe_users) & df["call_subs_id"].isin(universe_users)]

    if len(df) == 0:
        return pd.DataFrame(columns=["u", "v", "call_cnt", "days", "bases"])

    df["day"] = df["statis_ymd"].dt.date
    g = df.groupby(["subs_id", "call_subs_id"], as_index=False).agg(
        call_cnt=("call_subs_id", "size"),
        days=("day", "nunique"),
        bases=("posite_id", "nunique"),
    )
    g = g.rename(columns={"subs_id": "u", "call_subs_id": "v"})
    return g



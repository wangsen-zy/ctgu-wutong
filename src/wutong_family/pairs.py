from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

import numpy as np
import pandas as pd


RULE_KEYS = [
    ("same_pay_acct", "pay_acct_id"),
    ("same_building", "building_id"),
    ("same_share_grp", "grp_offer_ins_id"),
    ("same_family_net", "family_net_id"),
]


def _iter_pairs_from_groups(
    df_users: pd.DataFrame,
    key_col: str,
    max_group_size_full: int = 30,
    big_group_sample_k: int = 10,
    seed: int = 2025,
) -> Iterable[Tuple[str, str]]:
    rng = np.random.default_rng(seed)
    for _, g in df_users.dropna(subset=[key_col]).groupby(key_col):
        members = g["subs_id"].tolist()
        n = len(members)
        if n <= 1:
            continue
        if n <= max_group_size_full:
            for a, b in combinations(members, 2):
                yield (a, b) if a < b else (b, a)
        else:
            # Avoid O(n^2): connect each node to K random others.
            for i, a in enumerate(members):
                others = members[:i] + members[i + 1 :]
                if not others:
                    continue
                k = min(big_group_sample_k, len(others))
                picks = rng.choice(others, size=k, replace=False)
                for b in picks:
                    yield (a, b) if a < b else (b, a)


def generate_candidate_pairs(
    df_users: pd.DataFrame,
    call_edges: Optional[pd.DataFrame] = None,
    max_pairs_from_calls_per_user: int = 20,
    seed: int = 2025,
) -> pd.DataFrame:
    """
    Generate sparse candidate pairs for scoring.
    Sources:
      - same pay/building/share group/family net (capped for huge groups)
      - top-N call neighbors per user (by call count)
    """
    pair_set: Set[Tuple[str, str]] = set()

    for _, key in RULE_KEYS:
        if key in df_users.columns:
            for p in _iter_pairs_from_groups(df_users, key_col=key, seed=seed):
                pair_set.add(p)

    if call_edges is not None and len(call_edges) > 0:
        # keep top neighbors per user by call_cnt
        ce = call_edges.copy()
        ce = ce.sort_values(["u", "call_cnt"], ascending=[True, False])
        ce["rank"] = ce.groupby("u").cumcount() + 1
        ce = ce[ce["rank"] <= max_pairs_from_calls_per_user]

        for u, v in ce[["u", "v"]].itertuples(index=False, name=None):
            if u == v:
                continue
            pair_set.add((u, v) if u < v else (v, u))

    pairs = pd.DataFrame(list(pair_set), columns=["u", "v"])
    return pairs


def attach_rule_hits(pairs: pd.DataFrame, df_users: pd.DataFrame) -> pd.DataFrame:
    u = df_users.rename(columns={"subs_id": "u"}).copy()
    v = df_users.rename(columns={"subs_id": "v"}).copy()
    x = pairs.merge(u, on="u", how="left", suffixes=("", "_u"))
    x = x.merge(v, on="v", how="left", suffixes=("", "_v"))

    # rule hits based on equality (non-null)
    for feat, key in RULE_KEYS:
        ku = key
        kv = f"{key}_v"
        # after merge, v side columns have suffix _v if collision
        if kv not in x.columns:
            kv = key  # if original didn't collide (unlikely)
        x[feat] = ((x[ku].notna()) & (x[kv].notna()) & (x[ku] == x[kv])).astype("int8")

    def rule_name(row) -> str:
        for feat, _ in RULE_KEYS:
            if row.get(feat, 0) == 1:
                return feat
        return ""

    x["rule_hit"] = x.apply(rule_name, axis=1)
    return x


def build_pair_feature_table(
    pairs: pd.DataFrame,
    df_users: pd.DataFrame,
    call_edges: Optional[pd.DataFrame] = None,
) -> pd.DataFrame:
    """
    Build supervised table for (u,v) pairs.
    Includes:
      - rule equality flags
      - user diffs (age/arpu/dou/mou)
      - simple call stats (directed summed into undirected)
    """
    # Merge user features
    u = df_users.rename(columns={"subs_id": "u"}).copy()
    v = df_users.rename(columns={"subs_id": "v"}).copy()
    x = pairs.merge(u, on="u", how="left", suffixes=("", "_u"))
    x = x.merge(v, on="v", how="left", suffixes=("", "_v"))

    # Rule match flags
    for feat, key in RULE_KEYS:
        ku = key
        kv = f"{key}_v"
        if kv not in x.columns:
            kv = key
        x[feat] = ((x[ku].notna()) & (x[kv].notna()) & (x[ku] == x[kv])).astype("int8")

    # Numeric diffs
    for c in ["age", "arpu", "dou", "mou"]:
        cu = c
        cv = f"{c}_v"
        if cu in x.columns and cv in x.columns:
            x[f"{c}_diff"] = (x[cu].astype("float32") - x[cv].astype("float32")).abs()
            x[f"{c}_sum"] = x[cu].astype("float32") + x[cv].astype("float32")

    # Flags consistency (only binary 0/1 flags; exclude multi-class like dzdgx_flag)
    flag_cols = [
        c
        for c in df_users.columns
        if c.endswith("_flag")
        and c != "dzdgx_flag"
        and (pd.api.types.is_numeric_dtype(df_users[c]) or df_users[c].dropna().isin([0, 1, 0.0, 1.0]).all())
    ]
    for c in flag_cols:
        cu = c
        cv = f"{c}_v"
        if cu in x.columns and cv in x.columns:
            a = x[cu].fillna(0).astype("int8")
            b = x[cv].fillna(0).astype("int8")
            x[f"{c}_both1"] = (a & b).astype("int8")
            x[f"{c}_xor"] = (a ^ b).astype("int8")

    # Call stats (aggregate directed edges into undirected)
    if call_edges is not None and len(call_edges) > 0:
        ce = call_edges.copy()
        ce["a"] = ce[["u", "v"]].min(axis=1)
        ce["b"] = ce[["u", "v"]].max(axis=1)
        und = ce.groupby(["a", "b"], as_index=False).agg(
            call_cnt=("call_cnt", "sum"),
            call_days=("days", "sum"),
            call_bases=("bases", "sum"),
        )
        und = und.rename(columns={"a": "u", "b": "v"})
        x = x.merge(und, on=["u", "v"], how="left")
    else:
        x["call_cnt"] = 0.0
        x["call_days"] = 0.0
        x["call_bases"] = 0.0

    for c in ["call_cnt", "call_days", "call_bases"]:
        x[c] = x[c].fillna(0.0).astype("float32")

    # Keep a light column set for modeling; keep ids + rule_hit later during export.
    return x



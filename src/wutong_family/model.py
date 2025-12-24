from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
from sklearn.metrics import f1_score, precision_score, recall_score


@dataclass
class TrainResult:
    model: object
    feature_cols: List[str]
    threshold: float
    metrics: Dict[str, float]
    feature_importance: Optional[pd.DataFrame]


def best_threshold(y_true: np.ndarray, y_prob: np.ndarray) -> Tuple[float, Dict[str, float]]:
    """
    Pick threshold that maximizes F1 on provided labels/probabilities.
    Intended for validation/CV; do not call on training-fit unless you explicitly want that.
    """
    return _best_threshold(y_true=y_true, y_prob=y_prob)


def pick_feature_cols(df: pd.DataFrame) -> List[str]:
    bad = {"u", "v", "label", "family_phy_id", "family_c_id", "subs_type", "birth_day", "rule_hit"}
    cols = []
    for c in df.columns:
        if c in bad:
            continue
        if c.endswith("_v"):  # raw v-side user attrs (we use diffs / flags)
            continue
        if c in {"acct_id", "family_net_id", "grp_offer_ins_id", "building_id", "pay_acct_id", "gender_name", "building_area", "dzdgx_flag"}:
            continue
        if df[c].dtype == "O":
            continue
        cols.append(c)
    return cols


def _best_threshold(y_true: np.ndarray, y_prob: np.ndarray) -> Tuple[float, Dict[str, float]]:
    best_t = 0.5
    best_f1 = -1.0
    best = {}
    for t in np.linspace(0.1, 0.9, 81):
        y_pred = (y_prob >= t).astype(int)
        f1 = f1_score(y_true, y_pred)
        if f1 > best_f1:
            best_f1 = f1
            best_t = float(t)
            best = {
                "precision": float(precision_score(y_true, y_pred, zero_division=0)),
                "recall": float(recall_score(y_true, y_pred, zero_division=0)),
                "f1": float(f1),
            }
    return best_t, best


def train_lgbm(
    train_df: pd.DataFrame,
    label_col: str = "label",
    feature_cols: Optional[List[str]] = None,
    seed: int = 2025,
    device: str = "cpu",
):
    import lightgbm as lgb

    if feature_cols is None:
        feature_cols = pick_feature_cols(train_df)

    X = train_df[feature_cols]
    y = train_df[label_col].astype(int).values

    pos = (y == 1).sum()
    neg = (y == 0).sum()
    scale_pos_weight = float(neg / max(pos, 1))

    params = {
        "boosting_type": "gbdt",
        "objective": "binary",
        "metric": "binary_logloss",
        "learning_rate": 0.05,
        "num_leaves": 63,
        "max_depth": -1,
        "min_data_in_leaf": 200,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "lambda_l1": 0.1,
        "lambda_l2": 0.1,
        "seed": seed,
        "verbosity": -1,
        "n_jobs": 8,
        "scale_pos_weight": scale_pos_weight,
    }

    if device.lower() == "gpu":
        # Requires LightGBM built with GPU support.
        # If your build doesn't support it, LightGBM will error; switch back to --device cpu.
        params.update(
            {
                "device_type": "gpu",
                # Reasonable defaults; adjust if needed
                "gpu_use_dp": False,
            }
        )

    dtrain = lgb.Dataset(X, label=y)
    model = lgb.train(params, dtrain, num_boost_round=600)

    prob = model.predict(X)
    t, m = _best_threshold(y, prob)

    imp = pd.DataFrame(
        {"feature": feature_cols, "gain": model.feature_importance(importance_type="gain")}
    ).sort_values("gain", ascending=False)

    return TrainResult(model=model, feature_cols=feature_cols, threshold=t, metrics=m, feature_importance=imp)


def predict_proba(model, df: pd.DataFrame, feature_cols: Sequence[str]) -> np.ndarray:
    # Be robust when scoring unlabeled data: some training-only columns may not exist.
    X = df.copy()
    missing = [c for c in feature_cols if c not in X.columns]
    for c in missing:
        X[c] = 0.0
    return model.predict(X[list(feature_cols)])



from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import networkx as nx


def apply_rules_then_model(
    pair_df: pd.DataFrame,
    prob_model: np.ndarray,
    rule_prob: float = 0.99,
) -> pd.DataFrame:
    """
    If any strong rule hits, override probability with high confidence; otherwise use model.
    Expects pair_df to include same_* columns.
    """
    x = pair_df.copy()
    rule_mask = (
        (x.get("same_pay_acct", 0) == 1)
        | (x.get("same_building", 0) == 1)
        | (x.get("same_share_grp", 0) == 1)
        | (x.get("same_family_net", 0) == 1)
    )
    x["same_family_prob"] = prob_model.astype("float32")
    x.loc[rule_mask, "same_family_prob"] = float(rule_prob)

    def rule_name(row) -> str:
        for col in ["same_pay_acct", "same_building", "same_share_grp", "same_family_net"]:
            if row.get(col, 0) == 1:
                return col
        return ""

    x["rule_hit"] = x.apply(rule_name, axis=1)
    return x


def cluster_families(
    edges: pd.DataFrame,
    threshold: float,
    all_nodes: Optional[List[str]] = None,
) -> Tuple[pd.DataFrame, nx.Graph]:
    """
    Threshold edges, build an undirected graph, compute connected components as families.
    """
    keep = edges[edges["same_family_prob"] >= threshold].copy()
    g = nx.Graph()
    if all_nodes is not None:
        g.add_nodes_from(all_nodes)
    else:
        g.add_nodes_from(pd.unique(edges[["u", "v"]].values.ravel("K")))
    g.add_edges_from(keep[["u", "v"]].itertuples(index=False, name=None))

    comps = list(nx.connected_components(g))
    fam_rows = []
    for comp in comps:
        members = sorted(comp)
        if not members:
            continue
        fam_id = f"FAM_{members[0]}_{len(members)}"
        for m in members:
            fam_rows.append((m, fam_id))
    fam = pd.DataFrame(fam_rows, columns=["subs_id", "family_id_pred"])
    return fam, g


def pick_key_person(
    family_members: pd.DataFrame,
    edges: pd.DataFrame,
    user_df: pd.DataFrame,
) -> pd.DataFrame:
    """
    Pick key person per family:
      score = weighted_degree(prob) + 0.01 * arpu
    """
    # weighted degree within family
    e = edges.copy()
    deg = {}
    for u, v, p in e[["u", "v", "same_family_prob"]].itertuples(index=False, name=None):
        deg[u] = deg.get(u, 0.0) + float(p)
        deg[v] = deg.get(v, 0.0) + float(p)
    du = pd.DataFrame(list(deg.items()), columns=["subs_id", "wdeg"])
    x = family_members.merge(du, on="subs_id", how="left").fillna({"wdeg": 0.0})
    users = user_df[["subs_id", "arpu"]].copy() if "arpu" in user_df.columns else user_df[["subs_id"]].assign(arpu=0.0)
    x = x.merge(users, on="subs_id", how="left").fillna({"arpu": 0.0})
    x["kp_score"] = x["wdeg"].astype("float32") + 0.01 * x["arpu"].astype("float32")
    # mark top in each family
    x["key_person_flag"] = 0
    idx = x.groupby("family_id_pred")["kp_score"].idxmax()
    x.loc[idx, "key_person_flag"] = 1
    return x.drop(columns=["kp_score"])


def build_family_profile(family_members: pd.DataFrame, user_df: pd.DataFrame) -> pd.DataFrame:
    u = user_df.copy()
    x = family_members.merge(u, on="subs_id", how="left")
    agg = {
        "subs_id": "count",
    }
    for c in ["arpu", "dou", "mou", "age"]:
        if c in x.columns:
            agg[c] = "mean"
    # Only aggregate numeric/binary flags. Exclude multi-class `dzdgx_flag` (values like 否/共享/被共享).
    flag_cols = [c for c in x.columns if c.endswith("_flag") and c != "dzdgx_flag"]
    for c in flag_cols:
        # Safety: only mean over numeric-like columns
        if pd.api.types.is_numeric_dtype(x[c]):
            agg[c] = "mean"
    prof = x.groupby("family_id_pred", as_index=False).agg(agg).rename(columns={"subs_id": "size"})
    return prof



"""Pure math utilities for triage sweep embedding analysis.

All functions are stateless and perform no I/O (except model loading by FastEmbed).
Each function operates on numpy arrays and returns numpy arrays or plain Python types.
"""
from __future__ import annotations

import numpy as np
from numpy.typing import NDArray
from fastembed import TextEmbedding
from sklearn.decomposition import PCA
from sklearn.covariance import EllipticEnvelope
from sklearn.metrics.pairwise import cosine_similarity

# FastEmbed model — BAAI/bge-small-en-v1.5 produces 384-dimensional embeddings.
# ~46MB quantized ONNX, runs on CPU in ~0.5s per batch of 32.
EMBEDDING_MODEL: str = "BAAI/bge-small-en-v1.5"

# Embedding dimensionality (determined by model choice).
EMBEDDING_DIM: int = 384

# Batch size for FastEmbed. 32 balances memory and throughput on
# a 2-vCPU GitHub Actions runner with ~7GB RAM.
EMBEDDING_BATCH_SIZE: int = 32


def embed_texts(texts: list[str]) -> NDArray[np.float32]:
    """Embed a list of texts into dense vectors using FastEmbed.

    Returns an array of shape (len(texts), 384) with dtype float32.
    Empty input returns a (0, 384) array.
    """
    if not texts:
        return np.empty((0, EMBEDDING_DIM), dtype=np.float32)

    model = TextEmbedding(model_name=EMBEDDING_MODEL)
    vectors = list(model.embed(texts, batch_size=EMBEDDING_BATCH_SIZE))
    return np.vstack(vectors).astype(np.float32)


def normalize_rows(matrix: NDArray[np.float32]) -> NDArray[np.float32]:
    """L2-normalize each row to unit length.

    Zero-norm rows (e.g. from empty text) remain zero vectors.
    Uses eps=1e-10 in the denominator to avoid division by zero.
    """
    if matrix.shape[0] == 0:
        return matrix

    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / (norms + 1e-10)


def reduce_dimensions(
    matrix: NDArray[np.float32],
    max_components: int,
) -> NDArray[np.float32]:
    """Reduce dimensionality via PCA.

    Computes n_components = min(max_components, n-1, d). If n_components < 1,
    returns the matrix unchanged. Logs explained variance for observability.
    """
    n, d = matrix.shape
    if n <= 1:
        return matrix

    n_components = min(max_components, n - 1, d)
    if n_components < 1:
        return matrix

    pca = PCA(n_components=n_components)
    reduced = pca.fit_transform(matrix)
    explained = pca.explained_variance_ratio_.sum()
    print(f"PCA: {d}d -> {n_components}d, explained variance: {explained:.3f}")
    return reduced.astype(np.float32)


def detect_outliers(
    matrix: NDArray[np.float32],
    contamination: float = 0.1,
    iqr_multiplier: float = 3.0,
    max_outlier_pct: float = 0.05,
) -> list[tuple[int, float]]:
    """Flag items whose Mahalanobis distance exceeds an IQR-based cutoff.

    Uses EllipticEnvelope (robust covariance via MCD) to estimate the
    multivariate Gaussian, then computes sqrt(squared Mahalanobis distance)
    for each sample. The cutoff is Q75 + iqr_multiplier * IQR, which
    adapts to the actual distribution of distances.

    A hard cap ensures no more than max_outlier_pct * n items are flagged;
    when the cap is hit, only the most extreme items (sorted by distance
    descending) are kept.

    Returns (index, distance) tuples sorted by index ascending, along with
    the cutoff value stored as an attribute on the returned list.
    """
    n = matrix.shape[0]
    if n < 2:
        return []

    envelope = EllipticEnvelope(contamination=contamination, random_state=42)
    envelope.fit(matrix)

    # .mahalanobis() returns squared Mahalanobis distances
    distances = np.sqrt(envelope.mahalanobis(matrix))

    # IQR-based cutoff
    q25, q75 = np.percentile(distances, [25, 75])
    iqr = q75 - q25
    cutoff = q75 + iqr_multiplier * iqr

    outlier_mask = distances > cutoff
    indices = np.where(outlier_mask)[0]

    # Hard cap: keep at most max_outlier_pct * n items
    max_count = max(1, int(max_outlier_pct * n))
    if len(indices) > max_count:
        # Sort by distance descending, take the most extreme
        sorted_by_dist = sorted(indices, key=lambda i: distances[i], reverse=True)
        indices = np.array(sorted_by_dist[:max_count])

    # Sort by index ascending for stable output
    indices = np.sort(indices)
    result = [(int(idx), float(distances[idx])) for idx in indices]

    # Attach cutoff as metadata so the report can use it
    result = _OutlierResult(result)  # type: ignore[assignment]
    result.cutoff = float(cutoff)  # type: ignore[attr-defined]
    return result  # type: ignore[return-value]


class _OutlierResult(list):
    """A list subclass that carries metadata (cutoff) from outlier detection."""
    cutoff: float = 0.0


def find_duplicate_pairs(
    matrix: NDArray[np.float32],
    threshold: float,
) -> list[tuple[int, int, float]]:
    """Find pairs of items with cosine similarity above threshold.

    Returns (i, j, similarity) tuples where i < j. The input should be
    L2-normalized embeddings (full dimensionality, not PCA-reduced) so
    cosine similarity equals the dot product.
    """
    n = matrix.shape[0]
    if n <= 1:
        return []

    sim_matrix = cosine_similarity(matrix)
    # Upper triangle indices (i < j), excluding diagonal
    rows, cols = np.triu_indices(n, k=1)
    similarities = sim_matrix[rows, cols]

    mask = similarities > threshold
    pairs: list[tuple[int, int, float]] = []
    for idx in np.where(mask)[0]:
        pairs.append((int(rows[idx]), int(cols[idx]), float(similarities[idx])))

    return pairs


# ── Label suggestion via z-score normalized embedding similarity ──────

# Z-score threshold: a label must be this many standard deviations above
# the column mean to be considered a match.
LABEL_Z_THRESHOLD: float = 1.5

# Margin gate: the top-1 label must beat the second-best by this many
# z-score units to be accepted (subsequent labels don't need a margin).
LABEL_Z_MARGIN: float = 0.5

# Floor for per-column standard deviation to avoid division by near-zero.
LABEL_Z_STD_FLOOR: float = 0.01

# Minimum raw cosine similarity required even if z-score is high.
# Prevents suggesting labels that are "relatively best" but still poor.
MIN_RAW_SIMILARITY: float = 0.3

# Maximum number of labels to suggest per item.
MAX_LABELS_PER_ITEM: int = 3


def suggest_labels(
    item_embeddings: NDArray[np.float32],
    label_embeddings: NDArray[np.float32],
    label_names: list[str],
    z_threshold: float = LABEL_Z_THRESHOLD,
    z_margin: float = LABEL_Z_MARGIN,
    std_floor: float = LABEL_Z_STD_FLOOR,
    min_raw_sim: float = MIN_RAW_SIMILARITY,
    max_per_item: int = MAX_LABELS_PER_ITEM,
) -> list[list[tuple[str, float]]]:
    """Suggest labels for each item using z-score normalized similarity.

    1. Compute raw cosine similarity matrix (n items x m labels).
    2. Column-wise z-score: for each label j, normalize across all items.
    3. For each item, rank labels by z-score descending.
    4. Accept a label only if z >= z_threshold AND raw_sim >= min_raw_sim.
    5. Margin gate: the top-1 label must beat #2 by z_margin; subsequent
       labels don't need a margin.
    6. Cap at max_per_item.

    Returns a list of length n, where each element is a list of
    (label_name, raw_similarity) tuples. Empty list if nothing qualifies.
    """
    n = item_embeddings.shape[0]
    m = label_embeddings.shape[0]
    if n == 0 or m == 0:
        return [[] for _ in range(n)]

    # (n, m) raw similarity matrix
    sim_matrix = cosine_similarity(item_embeddings, label_embeddings)

    # Column-wise z-score normalization
    col_means = sim_matrix.mean(axis=0)  # shape (m,)
    col_stds = sim_matrix.std(axis=0)    # shape (m,)
    col_stds = np.maximum(col_stds, std_floor)
    z_matrix = (sim_matrix - col_means) / col_stds

    suggestions: list[list[tuple[str, float]]] = []
    for i in range(n):
        z_row = z_matrix[i]
        raw_row = sim_matrix[i]

        # Rank labels by z-score descending
        ranked = np.argsort(z_row)[::-1]

        item_labels: list[tuple[str, float]] = []

        # Margin gate: top-1 z-score must beat #2 by z_margin.
        # If not, the assignment is ambiguous — skip this item entirely.
        if len(ranked) > 1:
            top1_z = float(z_row[ranked[0]])
            top2_z = float(z_row[ranked[1]])
            if top1_z - top2_z < z_margin:
                suggestions.append(item_labels)
                continue

        for rank_pos, idx in enumerate(ranked):
            if len(item_labels) >= max_per_item:
                break

            z_val = float(z_row[idx])
            raw_val = float(raw_row[idx])

            # Must pass both z-threshold and raw similarity floor
            if z_val < z_threshold or raw_val < min_raw_sim:
                continue

            item_labels.append((label_names[idx], raw_val))

        suggestions.append(item_labels)

    return suggestions

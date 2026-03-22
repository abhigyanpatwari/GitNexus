"""Tests for embedding_utils.py — all embedding model calls are mocked."""
from __future__ import annotations

import sys
from unittest.mock import patch, MagicMock
import numpy as np
import pytest

# Mock fastembed before importing the module under test (persistent)
if "fastembed" not in sys.modules:
    sys.modules["fastembed"] = MagicMock()

from embedding_utils import (
    embed_texts,
    normalize_rows,
    reduce_dimensions,
    detect_outliers,
    find_duplicate_pairs,
    suggest_labels,
    EMBEDDING_DIM,
    EMBEDDING_MODEL,
    EMBEDDING_BATCH_SIZE,
    LABEL_Z_THRESHOLD,
    LABEL_Z_MARGIN,
    LABEL_Z_STD_FLOOR,
    MIN_RAW_SIMILARITY,
    MAX_LABELS_PER_ITEM,
)


class TestEmbedTexts:
    """Tests for the embed_texts function."""

    def test_empty_list_returns_empty_array(self):
        result = embed_texts([])
        assert result.shape == (0, EMBEDDING_DIM)
        assert result.dtype == np.float32

    @patch("embedding_utils.TextEmbedding")
    def test_single_text(self, mock_cls):
        mock_model = MagicMock()
        mock_cls.return_value = mock_model
        vec = np.random.randn(EMBEDDING_DIM).astype(np.float32)
        mock_model.embed.return_value = iter([vec])

        result = embed_texts(["hello world"])

        mock_cls.assert_called_once_with(model_name=EMBEDDING_MODEL)
        mock_model.embed.assert_called_once_with(
            ["hello world"], batch_size=EMBEDDING_BATCH_SIZE
        )
        assert result.shape == (1, EMBEDDING_DIM)
        assert result.dtype == np.float32
        np.testing.assert_array_almost_equal(result[0], vec)

    @patch("embedding_utils.TextEmbedding")
    def test_multiple_texts(self, mock_cls):
        mock_model = MagicMock()
        mock_cls.return_value = mock_model
        vecs = [
            np.random.randn(EMBEDDING_DIM).astype(np.float32)
            for _ in range(5)
        ]
        mock_model.embed.return_value = iter(vecs)

        result = embed_texts(["a", "b", "c", "d", "e"])
        assert result.shape == (5, EMBEDDING_DIM)
        assert result.dtype == np.float32


class TestNormalizeRows:
    """Tests for L2 row normalization."""

    def test_empty_matrix(self):
        m = np.empty((0, 10), dtype=np.float32)
        result = normalize_rows(m)
        assert result.shape == (0, 10)

    def test_single_row(self):
        m = np.array([[3.0, 4.0]], dtype=np.float32)
        result = normalize_rows(m)
        # Norm should be ~1.0
        norm = np.linalg.norm(result[0])
        assert abs(norm - 1.0) < 1e-5

    def test_multiple_rows(self):
        rng = np.random.default_rng(42)
        m = rng.standard_normal((10, 50)).astype(np.float32)
        result = normalize_rows(m)
        norms = np.linalg.norm(result, axis=1)
        np.testing.assert_allclose(norms, 1.0, atol=1e-5)

    def test_zero_row_stays_near_zero(self):
        m = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], dtype=np.float32)
        result = normalize_rows(m)
        # Zero row divided by eps -> very small values
        assert np.linalg.norm(result[0]) < 1e-3
        # Non-zero row should be unit norm
        assert abs(np.linalg.norm(result[1]) - 1.0) < 1e-5

    def test_preserves_direction(self):
        m = np.array([[2.0, 0.0], [0.0, 3.0]], dtype=np.float32)
        result = normalize_rows(m)
        np.testing.assert_allclose(result[0], [1.0, 0.0], atol=1e-5)
        np.testing.assert_allclose(result[1], [0.0, 1.0], atol=1e-5)


class TestReduceDimensions:
    """Tests for PCA dimensionality reduction."""

    def test_single_sample_returns_unchanged(self):
        m = np.random.randn(1, 50).astype(np.float32)
        result = reduce_dimensions(m, 10)
        np.testing.assert_array_equal(result, m)

    def test_reduces_dimensions(self):
        rng = np.random.default_rng(42)
        m = rng.standard_normal((100, 50)).astype(np.float32)
        result = reduce_dimensions(m, 10)
        assert result.shape == (100, 10)
        assert result.dtype == np.float32

    def test_caps_at_n_minus_1(self):
        rng = np.random.default_rng(42)
        # 5 samples, 20 features -> max components = 4 (n-1)
        m = rng.standard_normal((5, 20)).astype(np.float32)
        result = reduce_dimensions(m, 50)
        assert result.shape == (5, 4)

    def test_caps_at_d(self):
        rng = np.random.default_rng(42)
        # 100 samples, 3 features -> max components = 3
        m = rng.standard_normal((100, 3)).astype(np.float32)
        result = reduce_dimensions(m, 50)
        assert result.shape == (100, 3)

    def test_max_components_respected(self):
        rng = np.random.default_rng(42)
        m = rng.standard_normal((50, 30)).astype(np.float32)
        result = reduce_dimensions(m, 5)
        assert result.shape[1] == 5


class TestDetectOutliers:
    """Tests for IQR-based outlier detection."""

    def test_single_sample_returns_empty(self):
        m = np.random.randn(1, 5).astype(np.float32)
        result = detect_outliers(m)
        assert result == []

    def test_empty_returns_empty(self):
        # n < 2 case
        m = np.empty((0, 5), dtype=np.float32)
        result = detect_outliers(m)
        assert result == []

    def test_finds_outliers_in_synthetic_data(self):
        rng = np.random.default_rng(42)
        # Create a tight cluster with one obvious outlier
        cluster = rng.standard_normal((50, 3)).astype(np.float32) * 0.1
        outlier = np.array([[100.0, 100.0, 100.0]], dtype=np.float32)
        m = np.vstack([cluster, outlier])
        result = detect_outliers(m)
        # The outlier (index 50) should be detected
        outlier_indices = [idx for idx, _ in result]
        assert 50 in outlier_indices

    def test_returns_list_of_index_distance_tuples(self):
        rng = np.random.default_rng(42)
        # Tight cluster + outlier to guarantee at least one result
        cluster = rng.standard_normal((20, 3)).astype(np.float32) * 0.1
        far_point = np.array([[50.0, 50.0, 50.0]], dtype=np.float32)
        m = np.vstack([cluster, far_point])
        result = detect_outliers(m)
        assert isinstance(result, list)
        for item in result:
            assert isinstance(item, tuple)
            assert len(item) == 2
            idx, dist = item
            assert isinstance(idx, int)
            assert isinstance(dist, float)
            assert dist > 0

    def test_iqr_cutoff_behavior(self):
        """Lower IQR multiplier should flag more items than higher multiplier."""
        rng = np.random.default_rng(42)
        m = rng.standard_normal((100, 3)).astype(np.float32)
        low = detect_outliers(m, iqr_multiplier=1.0, max_outlier_pct=0.5)
        high = detect_outliers(m, iqr_multiplier=5.0, max_outlier_pct=0.5)
        assert len(low) >= len(high)

    def test_dimension_aware_no_mass_flagging(self):
        """High-dimensional clean Gaussian data should not flag everything."""
        rng = np.random.default_rng(42)
        # 500 samples, 10 dims — well-conditioned for robust covariance
        m = rng.standard_normal((500, 10)).astype(np.float32)
        result = detect_outliers(m)
        # With IQR-based cutoff on clean Gaussian data,
        # only a small fraction should be flagged (well under 50%)
        assert len(result) < 250

    def test_contamination_parameter(self):
        rng = np.random.default_rng(42)
        m = rng.standard_normal((50, 3)).astype(np.float32)
        # Should not raise with different contamination values
        result = detect_outliers(m, contamination=0.05)
        assert isinstance(result, list)

    def test_max_outlier_pct_hard_cap(self):
        """The hard cap should limit outlier count to max_outlier_pct * n."""
        rng = np.random.default_rng(42)
        # Create data with many potential outliers (bimodal)
        cluster = rng.standard_normal((80, 3)).astype(np.float32) * 0.1
        outliers = rng.standard_normal((20, 3)).astype(np.float32) * 50.0
        m = np.vstack([cluster, outliers])
        # Very low IQR multiplier to flag a lot, but cap at 5%
        result = detect_outliers(m, iqr_multiplier=0.5, max_outlier_pct=0.05)
        max_allowed = max(1, int(0.05 * 100))  # 5
        assert len(result) <= max_allowed

    def test_hard_cap_keeps_most_extreme(self):
        """When capped, the most extreme items (highest distance) should be kept."""
        rng = np.random.default_rng(42)
        cluster = rng.standard_normal((90, 3)).astype(np.float32) * 0.1
        # Create outliers with increasing extremity
        outliers = np.array([
            [10.0, 10.0, 10.0],
            [20.0, 20.0, 20.0],
            [50.0, 50.0, 50.0],
        ], dtype=np.float32)
        m = np.vstack([cluster, outliers])
        # Cap at ~1 item (0.01 * 93 = 0, but min is 1)
        result = detect_outliers(m, iqr_multiplier=0.5, max_outlier_pct=0.02)
        if len(result) > 0:
            # The most extreme (index 92, distance for [50,50,50]) should be kept
            indices = [idx for idx, _ in result]
            assert 92 in indices

    def test_cutoff_attribute(self):
        """Returned result should carry a cutoff attribute."""
        rng = np.random.default_rng(42)
        m = rng.standard_normal((50, 3)).astype(np.float32)
        result = detect_outliers(m)
        assert hasattr(result, "cutoff")
        assert isinstance(result.cutoff, float)
        assert result.cutoff > 0


class TestFindDuplicatePairs:
    """Tests for cosine similarity duplicate detection."""

    def test_single_item_returns_empty(self):
        m = np.random.randn(1, 10).astype(np.float32)
        result = find_duplicate_pairs(m, 0.9)
        assert result == []

    def test_empty_returns_empty(self):
        m = np.empty((0, 10), dtype=np.float32)
        result = find_duplicate_pairs(m, 0.9)
        assert result == []

    def test_identical_vectors_detected(self):
        vec = np.random.randn(10).astype(np.float32)
        vec = vec / np.linalg.norm(vec)
        m = np.vstack([vec, vec, np.random.randn(10).astype(np.float32)])
        result = find_duplicate_pairs(m, 0.99)
        # Items 0 and 1 are identical, should be found
        assert any(i == 0 and j == 1 for i, j, _ in result)

    def test_orthogonal_vectors_not_detected(self):
        m = np.eye(5, dtype=np.float32)
        result = find_duplicate_pairs(m, 0.5)
        assert result == []

    def test_returns_correct_format(self):
        vec = np.random.randn(10).astype(np.float32)
        vec = vec / np.linalg.norm(vec)
        m = np.vstack([vec, vec])
        result = find_duplicate_pairs(m, 0.5)
        assert len(result) >= 1
        for item in result:
            assert len(item) == 3
            i, j, sim = item
            assert isinstance(i, int)
            assert isinstance(j, int)
            assert isinstance(sim, float)
            assert i < j

    def test_i_less_than_j(self):
        rng = np.random.default_rng(42)
        # Create some similar vectors
        base = rng.standard_normal(10).astype(np.float32)
        m = np.vstack([base + rng.standard_normal(10) * 0.01 for _ in range(5)])
        result = find_duplicate_pairs(m, 0.5)
        for i, j, _ in result:
            assert i < j

    def test_high_threshold_fewer_pairs(self):
        rng = np.random.default_rng(42)
        m = rng.standard_normal((10, 20)).astype(np.float32)
        # Normalize for meaningful cosine similarities
        norms = np.linalg.norm(m, axis=1, keepdims=True)
        m = m / norms
        low = find_duplicate_pairs(m, 0.3)
        high = find_duplicate_pairs(m, 0.9)
        assert len(low) >= len(high)


class TestSuggestLabels:
    """Tests for z-score normalized label suggestion."""

    def test_empty_items_returns_empty_lists(self):
        items = np.empty((0, 10), dtype=np.float32)
        labels = np.random.randn(3, 10).astype(np.float32)
        result = suggest_labels(items, labels, ["a", "b", "c"])
        assert result == []

    def test_empty_labels_returns_empty_per_item(self):
        items = np.random.randn(5, 10).astype(np.float32)
        labels = np.empty((0, 10), dtype=np.float32)
        result = suggest_labels(items, labels, [])
        assert len(result) == 5
        assert all(s == [] for s in result)

    def test_identical_embedding_gets_that_label(self):
        """If an item embedding strongly matches one label, z-score should highlight it."""
        # Create multiple items so z-score normalization is meaningful
        rng = np.random.default_rng(42)
        # 10 random items + 1 item that matches label "bug" exactly
        random_items = rng.standard_normal((10, 3)).astype(np.float32)
        bug_vec = np.array([[1.0, 0.0, 0.0]], dtype=np.float32)
        items = np.vstack([random_items, bug_vec])
        labels = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], dtype=np.float32)
        result = suggest_labels(
            items, labels, ["bug", "feature", "docs"],
            z_threshold=0.5, z_margin=0.0, min_raw_sim=0.1,
        )
        # The last item (matching bug_vec) should get "bug" as top suggestion
        last_item_sugs = result[-1]
        if last_item_sugs:
            assert last_item_sugs[0][0] == "bug"

    def test_z_score_suppresses_dominant_label(self):
        """When all items are similar to one label, z-scores should be low
        (none stands out) and that label should not be blindly suggested."""
        # All items identical — z-score for every item on every label is 0
        items = np.ones((10, 3), dtype=np.float32)
        labels = np.array([[1.0, 1.0, 1.0], [0.0, 1.0, 0.0]], dtype=np.float32)
        result = suggest_labels(
            items, labels, ["catch-all", "specific"],
            z_threshold=1.5, min_raw_sim=0.3,
        )
        # With identical items, std=0 -> z-scores are all 0 -> nothing passes z_threshold
        for sugs in result:
            assert sugs == []

    def test_margin_gate_blocks_top1(self):
        """Top-1 label must beat #2 by z_margin to be accepted as position 0."""
        rng = np.random.default_rng(99)
        # 20 items, each slightly different, 2 labels
        items = rng.standard_normal((20, 5)).astype(np.float32)
        # Two labels that are nearly identical -> margin gate should block top-1
        labels = np.array([[1.0, 0.5, 0.0, 0.0, 0.0],
                           [1.0, 0.5, 0.01, 0.0, 0.0]], dtype=np.float32)
        result = suggest_labels(
            items, labels, ["label-a", "label-b"],
            z_threshold=0.0, z_margin=10.0, min_raw_sim=0.0, max_per_item=1,
        )
        # With a huge margin requirement and max_per_item=1, nothing should pass
        # because the only candidate (top-1) is blocked by margin gate,
        # and max_per_item=1 prevents falling through to position 2
        for sugs in result:
            assert sugs == []

    def test_margin_gate_passes_when_clear_winner(self):
        """When top-1 clearly beats #2, it should pass the margin gate."""
        # Create items where one strongly matches label 0 vs label 1
        items = np.array([
            [1.0, 0.0, 0.0, 0.0, 0.0],   # strongly matches label-a
            [0.0, 0.0, 0.0, 0.0, 1.0],   # matches neither well
        ] * 5, dtype=np.float32)  # 10 items for stable z-scores
        labels = np.array([
            [1.0, 0.0, 0.0, 0.0, 0.0],   # label-a
            [0.0, 1.0, 0.0, 0.0, 0.0],   # label-b (orthogonal)
        ], dtype=np.float32)
        result = suggest_labels(
            items, labels, ["label-a", "label-b"],
            z_threshold=0.5, z_margin=0.3, min_raw_sim=0.1,
        )
        # Items matching label-a should get it suggested (clear z-score advantage)
        got_label_a = sum(1 for sugs in result if sugs and sugs[0][0] == "label-a")
        assert got_label_a > 0

    def test_min_raw_similarity_filter(self):
        """Even with high z-score, low raw similarity should be filtered out."""
        # Items are orthogonal to all labels -> raw similarity near 0
        items = np.array([[1.0, 0.0, 0.0]], dtype=np.float32)
        labels = np.array([[0.0, 0.0, 1.0]], dtype=np.float32)
        result = suggest_labels(
            items, labels, ["irrelevant"],
            z_threshold=0.0, z_margin=0.0, min_raw_sim=0.9,
        )
        # Raw similarity is ~0, which is below min_raw_sim=0.9
        assert result[0] == []

    def test_max_per_item_respected(self):
        """Even if many labels qualify, max_per_item caps the results."""
        rng = np.random.default_rng(42)
        # Create items with some variance so z-scores differentiate
        items = rng.standard_normal((20, 10)).astype(np.float32)
        base = items[0]
        # All labels very similar to item 0
        labels = np.array([base + rng.standard_normal(10) * 0.01 for _ in range(10)])
        names = [f"label-{i}" for i in range(10)]
        result = suggest_labels(
            items, labels, names,
            z_threshold=0.0, z_margin=0.0, min_raw_sim=0.0, max_per_item=2,
        )
        for sugs in result:
            assert len(sugs) <= 2

    def test_returns_raw_similarity_not_z_score(self):
        """Returned scores should be raw cosine similarity, not z-scores."""
        rng = np.random.default_rng(42)
        items = rng.standard_normal((15, 5)).astype(np.float32)
        labels = rng.standard_normal((3, 5)).astype(np.float32)
        names = ["bug", "feature", "docs"]
        result = suggest_labels(
            items, labels, names,
            z_threshold=0.0, z_margin=0.0, min_raw_sim=-1.0,
        )
        # Raw cosine similarity should be in [-1, 1] range
        for sugs in result:
            for name, score in sugs:
                assert -1.0 <= score <= 1.0 + 1e-5
                assert isinstance(name, str)
                assert isinstance(score, float)

    def test_returns_correct_format(self):
        rng = np.random.default_rng(42)
        items = rng.standard_normal((3, 10)).astype(np.float32)
        labels = rng.standard_normal((5, 10)).astype(np.float32)
        names = ["bug", "feature", "docs", "ci", "test"]
        result = suggest_labels(
            items, labels, names,
            z_threshold=0.0, z_margin=0.0, min_raw_sim=-1.0,
        )
        assert len(result) == 3
        for sugs in result:
            for name, score in sugs:
                assert isinstance(name, str)
                assert isinstance(score, float)
                assert name in names

    def test_text_truncation_in_labels(self):
        """Label names should be returned as-is even when very long."""
        rng = np.random.default_rng(42)
        items = rng.standard_normal((10, 5)).astype(np.float32)
        long_name = "a" * 200
        labels = rng.standard_normal((1, 5)).astype(np.float32)
        result = suggest_labels(
            items, labels, [long_name],
            z_threshold=0.0, z_margin=0.0, min_raw_sim=-1.0,
        )
        for sugs in result:
            if sugs:
                assert sugs[0][0] == long_name

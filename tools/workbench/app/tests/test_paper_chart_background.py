"""Observed grid crossings survive erasure; absent and one-sided strokes stay absent."""
from pathlib import Path
import sys
import unittest

import cv2 as cv
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from paper_chart_background import ink_mask, restore_background

BLUE = (20, 90, 210)


class ChartBackgroundTests(unittest.TestCase):
    def test_large_markers_restore_light_grid_at_multiple_scales(self):
        for scale in (1, 2, 4):
            with self.subTest(scale=scale):
                original = np.full((120*scale, 160*scale, 3), 255, np.uint8)
                original[60*scale, :] = 240
                original[:, 80*scale] = 248
                painted = original.copy()
                cv.circle(painted, (80*scale, 60*scale), 15*scale, BLUE, -1)
                mask = np.zeros(original.shape[:2], np.uint8)
                cv.circle(mask, (80*scale, 60*scale), 17*scale, 1, -1)
                restored = restore_background(painted, mask)
                # All originally visible gray pixels remain byte-identical.
                neutral = painted.max(axis=2) == painted.min(axis=2)
                self.assertTrue(np.array_equal(restored[neutral], painted[neutral]))
                self.assertTrue(np.all(restored[60*scale, 60*scale:75*scale] == 240))
                self.assertTrue(np.all(restored[40*scale:55*scale, 80*scale] == 248))
                self.assertTrue(np.all(restored[68*scale, 80*scale+3] == 255))
                self.assertTrue(np.array_equal(painted[~mask.astype(bool)], restored[~mask.astype(bool)]))

    def test_no_grid_stays_blank_and_mask_does_not_change_neutral_labels(self):
        original = np.full((100, 140, 3), 255, np.uint8)
        original[80, 10:130] = 0
        original[10:80, 10] = 0
        painted = original.copy()
        cv.line(painted, (35, 30), (105, 55), BLUE, 5)
        mask = np.zeros(original.shape[:2], np.uint8)
        cv.line(mask, (35, 30), (105, 55), 1, 9)
        mask[75:84, 8:135] = 1  # Deliberately expanded cleanup near an axis/tick.
        self.assertTrue(np.array_equal(restore_background(painted, mask), original))

    def test_one_sided_grid_is_not_extended_into_removed_ink(self):
        original = np.full((100, 140, 3), 255, np.uint8)
        original[50, :70] = 230
        painted = original.copy()
        cv.circle(painted, (70, 50), 15, BLUE, -1)
        mask = np.zeros(original.shape[:2], np.uint8)
        cv.circle(mask, (70, 50), 17, 1, -1)
        restored = restore_background(painted, mask)
        self.assertTrue(np.all(restored[50, 56:86] == 255))
        self.assertTrue(np.array_equal(restored[50, :55], original[50, :55]))

    def test_existing_gaps_and_missing_grid_rows_are_not_filled(self):
        original = np.full((120, 160, 3), 255, np.uint8)
        original[30, :] = 240
        original[90, :] = 240
        original[30, 100:125] = 255
        painted = original.copy()
        cv.line(painted, (20, 20), (80, 100), BLUE, 5)
        mask = np.zeros(original.shape[:2], np.uint8)
        cv.line(mask, (20, 20), (80, 100), 1, 9)
        restored = restore_background(painted, mask)
        self.assertTrue(np.all(restored[60, :] == 255))
        self.assertTrue(np.all(restored[30, 100:125] == 255))
        self.assertTrue(np.array_equal(restored[~mask.astype(bool)], original[~mask.astype(bool)]))

    def test_edge_occlusion_requires_two_sided_evidence(self):
        original = np.full((90, 120, 3), 255, np.uint8)
        original[45, :] = 240
        painted = original.copy(); painted[:, :20] = BLUE
        mask = np.zeros(original.shape[:2], np.uint8); mask[:, :23] = 1
        restored = restore_background(painted, mask)
        self.assertTrue(np.all(restored[45, :20] == 255))
        self.assertTrue(np.all(restored[45, 20:] == 240))

    def test_effective_mask_excludes_visible_axes_and_grids(self):
        image = np.array([[[20,90,210], [240,240,240], [0,0,0], [255,255,255]]], np.uint8)
        self.assertEqual(ink_mask(image, np.ones((1,4), bool)).tolist(), [[True,False,False,False]])
        self.assertTrue(np.array_equal(restore_background(image, np.zeros((1,4), bool)), image))


if __name__ == '__main__':
    unittest.main()

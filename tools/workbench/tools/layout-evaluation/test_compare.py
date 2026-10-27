import unittest
from compare import compare


class ComparisonTest(unittest.TestCase):
    def test_missed_and_wrong_caption_are_counted(self):
        gold = [{'pageIndex': 0, 'bbox': [0, 0, 10, 10], 'label': 'Caption'}, {'pageIndex': 0, 'bbox': [20, 0, 30, 10], 'label': 'Caption'}]
        predictions = [{'pageIndex': 0, 'bbox': [0, 0, 10, 10], 'label': 'Text'}, {'pageIndex': 0, 'bbox': [40, 0, 50, 10], 'label': 'Caption'}]
        result = compare(gold, predictions)
        self.assertEqual(result['matched'], 1)
        self.assertEqual(result['unmatchedGold'], 1)
        self.assertEqual(result['caption']['precision'], 0)
        self.assertEqual(result['caption']['recall'], 0)
        self.assertIsNone(result['readingOrder']['agreement'])

    def test_reading_order_is_only_within_page(self):
        gold = [{'pageIndex': 0, 'bbox': [0, 0, 10, 10], 'label': 'Text', 'order': 0}, {'pageIndex': 0, 'bbox': [20, 0, 30, 10], 'label': 'Text', 'order': 1}, {'pageIndex': 1, 'bbox': [0, 0, 10, 10], 'label': 'Text', 'order': 0}]
        predicted = [dict(gold[0], order=1), dict(gold[1], order=0), dict(gold[2], order=0)]
        result = compare(gold, predicted)
        self.assertEqual(result['readingOrder'], {'comparablePairs': 1, 'agreement': 0})


if __name__ == '__main__':
    unittest.main()

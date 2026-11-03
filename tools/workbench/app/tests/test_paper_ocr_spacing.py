import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
from paper_ocr_spacing import present,numeric_gaps,_default_spacer

def tokens(text,gap_at=None):
    out=[];x=0
    for i,c in enumerate(text.replace(' ','')):
        if i==gap_at:x+=15
        out.append({'text':c,'bbox':[x,0,x+20,30]});x+=20
    return out

class SpacingTests(unittest.TestCase):
    def test_numeric_gap_and_decimal_preservation(self):
        raw='치료군 6.269.8';result=present(raw,tokens(raw,6),spacer=lambda t:t)
        self.assertEqual(result['displayText'],'치료군 6.2 69.8');self.assertEqual(raw,'치료군 6.269.8')
        self.assertEqual(numeric_gaps('6.2698',tokens('6.2698'))[0],'6.2698')
    def test_nonwhitespace_changes_are_rejected(self):
        result=present('7.8',spacer=lambda t:'7.9')
        self.assertEqual(result['displayText'],'7.8');self.assertIn('non-whitespace-change-rejected',result['spacing']['methods'])
    def test_resampled_ctc_boxes_keep_a_visible_number_boundary(self):
        data=tokens('6.269.8')
        for i,t in enumerate(data):
            t['bbox']=[v*1.9 if j in (0,2) else v for j,v in enumerate(t['bbox'])]
            if i>=3:t['bbox'][0]+=9;t['bbox'][2]+=9
        self.assertEqual(numeric_gaps('6.269.8',data)[0],'6.2 69.8')
    def test_missing_optional_spacer_keeps_geometric_recovery(self):
        def missing(t):raise ImportError()
        result=present('6.269.8',tokens('6.269.8',3),spacer=missing)
        self.assertEqual(result['displayText'],'6.2 69.8')
    def test_token_text_mismatch_cannot_split_a_number(self):
        self.assertEqual(numeric_gaps('123.4',tokens('1234',2))[0],'123.4')
    def test_short_scientific_labels_are_not_linguistically_split(self):
        self.assertEqual(_default_spacer('대조군 7.8 60.4'),'대조군 7.8 60.4')

if __name__=='__main__':unittest.main()

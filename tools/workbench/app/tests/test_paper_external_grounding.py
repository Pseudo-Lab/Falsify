"""Offline unit tests for paper_external_grounding and paper_clinical_trials."""
import hashlib
import json
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_clinical_trials as pct
import paper_external_grounding as peg


def no_network(*args, **kwargs):
    raise AssertionError('unexpected_real_network_call')


def sha_json(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode('utf-8')).hexdigest()


class ReferenceParsingTests(unittest.TestCase):
    def test_parse_numbered_dict_and_string_entries(self):
        entry = {
            'index': 4,
            'rawText': '[4] Smith J, Doe A. Effects of aspirin on cardiovascular mortality. Lancet. 2021; doi:10.1016/S0140-6736(21)0001-2 PMID: 33445566 PMCID: PMC8123456',
            'doi': '10.1016/S0140-6736(21)0001-2',
            'year': 2021,
        }
        parsed = peg.parse_reference_entry(entry)
        self.assertEqual(parsed['index'], 4)
        self.assertEqual(parsed['doi'], '10.1016/S0140-6736(21)0001-2')
        self.assertEqual(parsed['pmid'], '33445566')
        self.assertEqual(parsed['pmcid'], 'PMC8123456')
        self.assertEqual(parsed['year'], 2021)
        self.assertEqual(parsed['firstAuthorSurname'], 'Smith')
        self.assertIn('Effects of aspirin on cardiovascular mortality', parsed['titleCandidate'])

        raw_ay = 'Kim, S.-H. (2022). Deep learning triage in emergency care. BMJ Open 12:e050123. https://doi.org/10.1136/bmjopen-2022-050123'
        parsed_ay = peg.parse_reference_entry(raw_ay)
        self.assertIsNone(parsed_ay['index'])
        self.assertEqual(parsed_ay['doi'], '10.1136/bmjopen-2022-050123')
        self.assertEqual(parsed_ay['year'], 2022)
        self.assertEqual(parsed_ay['firstAuthorSurname'], 'Kim')
        self.assertIn('Deep learning triage in emergency care', parsed_ay['titleCandidate'])


class BibliographyVerificationTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_verify_doi_match_404_and_chimera_mismatch(self):
        refs = [
            '[1] Smith J. Effects of aspirin on cardiovascular mortality. Lancet. 2021; doi:10.1000/valid1',
            '[2] Doe A. Fabricated study on unicorns. Nature. 2024; doi:10.1000/missing404',
            '[3] Lee K. Novel immunotherapy for pancreatic cancer. Science. 2023; doi:10.1000/chimera1',
        ]

        def mock_transport(provider, path):
            if provider == 'crossref' and '10.1000%2Fvalid1' in path:
                data = {'message': {
                    'DOI': '10.1000/valid1',
                    'title': ['Effects of aspirin on cardiovascular mortality'],
                    'author': [{'given': 'John', 'family': 'Smith'}],
                    'published': {'date-parts': [[2021]]},
                }}
                return 200, data, sha_json(data)
            if provider == 'crossref' and '10.1000%2Fmissing404' in path:
                return 404, None, hashlib.sha256(b'Resource not found.').hexdigest()
            if provider == 'crossref' and '10.1000%2Fchimera1' in path:
                data = {'message': {
                    'DOI': '10.1000/chimera1',
                    'title': ['Soil microbiome diversity in boreal forests'],
                    'author': [{'given': 'Maria', 'family': 'Gonzalez'}],
                    'published': {'date-parts': [[2016]]},
                }}
                return 200, data, sha_json(data)
            if provider == 'europepmc':
                empty = {'resultList': {'result': []}}
                return 200, empty, sha_json(empty)
            raise AssertionError((provider, path))

        out = peg.verify_bibliography(refs, max_refs=25, transport=mock_transport)
        self.assertEqual(out['status'], 'completed')
        self.assertEqual(out['checkedCount'], 3)
        statuses = [r['status'] for r in out['results']]
        self.assertEqual(statuses, ['verified_match', 'doi_not_found_in_crossref', 'metadata_mismatch'])
        for rec in out['results']:
            self.assertIn('responseSha256', rec)
            self.assertIn('retrievedAt', rec)
            self.assertIn('provider', rec)
            self.assertIn('scope', rec)
        self.assertIn('404', out['results'][1]['scope'])
        self.assertLess(out['results'][2]['mismatchDetails']['titleOverlap'], 0.25)

    def test_verify_without_doi_match_and_missing_caveat(self):
        refs = [
            '[1] Patel R. Randomized trial of telemonitoring in heart failure. Circulation. 2022.',
            '[2] Unknown Z. Completely unindexed unpublished workshop handout. 2019.',
        ]

        def mock_transport(provider, path):
            if provider == 'europepmc' and 'telemonitoring' in path.lower():
                data = {'resultList': {'result': [{
                    'doi': '10.1161/CIRC.2022.100',
                    'title': 'Randomized trial of telemonitoring in heart failure',
                    'authorString': 'Patel R, Kumar S',
                    'pubYear': '2022',
                    'abstractText': 'Telemonitoring reduced readmissions by 22% (p < 0.01).',
                }]}}
                return 200, data, sha_json(data)
            empty = {'message': {'items': []}} if provider == 'crossref' else {'resultList': {'result': []}}
            return 200, empty, sha_json(empty)

        out = peg.verify_bibliography(refs, max_refs=25, transport=mock_transport)
        self.assertEqual(out['results'][0]['status'], 'verified_by_metadata')
        self.assertEqual(out['results'][1]['status'], 'unverified_no_match')
        self.assertIn('Missing search match is not proof of fabrication', out['results'][1]['scope'])

    def test_max_refs_bounds(self):
        with self.assertRaises(ValueError):
            peg.verify_bibliography([], max_refs=0)
        with self.assertRaises(ValueError):
            peg.verify_bibliography([], max_refs=51)

    def test_chimera_mismatch_via_year_diff_even_when_surname_collides(self):
        refs = ['[1] Smith J. Quantum baking recipes in space. Science. 2024; doi:10.1000/yeargap']

        def mock_transport(provider, path):
            if provider == 'crossref':
                data = {'message': {
                    'DOI': '10.1000/yeargap',
                    'title': ['Marine ecology of coral reefs'],
                    'author': [{'given': 'Jane', 'family': 'Smith'}],
                    'published': {'date-parts': [[2019]]},
                }}
                return 200, data, sha_json(data)
            return 200, {'resultList': {'result': []}}, sha_json({})

        out = peg.verify_bibliography(refs, transport=mock_transport)
        self.assertEqual(out['results'][0]['status'], 'metadata_mismatch')
        self.assertEqual(out['results'][0]['mismatchDetails']['yearDiff'], 5)


class ClaimGroundingTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_ground_cited_claims_prioritization_and_abstract_truncation(self):
        long_abstract = 'A' * 3600
        segments = [
            {'id': 's1', 'text': 'Several background studies exist [1].'},
            {'id': 's2', 'text': 'Treatment significantly decreased 30-day mortality by 35% (HR 0.65, p < 0.001) [1, 2].'},
            {'id': 's3', 'text': '선행 연구와 대조적으로 (Smith et al., 2020) 유병률이 18% 유의하게 증가하였다.'},
        ]
        refs = [
            '[1] Jones B. Background study. BMJ. 2019; doi:10.1000/j1',
            '[2] Smith A. Mortality trial in sepsis. NEJM. 2020; doi:10.1000/s2',
        ]

        def mock_transport(provider, path):
            if provider == 'europepmc' and '10.1000' in path:
                doi = '10.1000/s2' if 's2' in path else '10.1000/j1'
                title = 'Mortality trial in sepsis' if 's2' in path else 'Background study'
                author = 'Smith A' if 's2' in path else 'Jones B'
                year = '2020' if 's2' in path else '2019'
                data = {'resultList': {'result': [{
                    'doi': doi, 'title': title, 'authorString': author,
                    'pubYear': year, 'abstractText': long_abstract if 's2' in path else 'Short background.',
                }]}}
                return 200, data, sha_json(data)
            if provider == 'crossref':
                return 404, None, hashlib.sha256(b'not found').hexdigest()
            raise AssertionError((provider, path))

        out = peg.ground_cited_claims(segments, refs, max_claims=3, transport=mock_transport)
        self.assertEqual(out['status'], 'completed')
        self.assertEqual(len(out['claimGroundings']), 3)
        # Quantitative/causal claims in s2/s3 should rank ahead of generic background in s1.
        self.assertIn(out['claimGroundings'][0]['segmentId'], ('s2', 's3'))
        self.assertEqual(out['claimGroundings'][-1]['segmentId'], 's1')
        s2_smith = next(g for g in out['claimGroundings'] if g['refIndex'] == 2)
        rec = s2_smith['retrievedRecord']
        self.assertEqual(len(rec['abstract']), 3500)
        self.assertTrue(rec['abstractTruncated'])
        self.assertTrue(rec['textSha256'])
        self.assertTrue(rec['responseSha256'])

    def test_ground_cited_claims_expands_bracket_ranges(self):
        refs = [
            '[3] Alpha A. Trial three. JAMA. 2020; doi:10.1000/r3',
            '[4] Beta B. Trial four. JAMA. 2021; doi:10.1000/r4',
            '[5] Gamma C. Trial five. JAMA. 2022; doi:10.1000/r5',
        ]
        text = 'Prior trials showed significant mortality reduction [3-5].'

        def mock_transport(provider, path):
            if provider == 'europepmc':
                return 200, {'resultList': {'result': [{'doi': '10.1000/r3', 'title': 'Trial', 'authorString': 'Alpha A', 'pubYear': '2020', 'abstractText': 'Reduced mortality.'}]}}, sha_json({'ok': 1})
            return 404, None, hashlib.sha256(b'404').hexdigest()

        out = peg.ground_cited_claims(text, refs, max_claims=12, transport=mock_transport)
        self.assertEqual([g['refIndex'] for g in out['claimGroundings']], [3, 4, 5])


class ClinicalTrialsTests(unittest.TestCase):
    def setUp(self):
        self._net = patch.object(socket, 'create_connection', side_effect=no_network)
        self._net.start()

    def tearDown(self):
        self._net.stop()

    def test_extract_trial_ids_bounded_and_normalized(self):
        ids = [f'nct{10000000 + i}' for i in range(12)]
        text = ' '.join(ids) + ' NCT10000000 NCT123456789 (not 9 digits)'
        extracted = pct.extract_trial_ids(text)
        self.assertEqual(len(extracted), 10)
        self.assertEqual(extracted[0], 'NCT10000000')
        self.assertEqual(extracted[-1], 'NCT10000009')

    def test_fetch_and_compare_outcome_switch_and_enrollment(self):
        study = {
            'protocolSection': {
                'identificationModule': {'nctId': 'NCT04567890', 'briefTitle': 'Cardio Drug Trial', 'officialTitle': 'Official'},
                'statusModule': {
                    'overallStatus': 'COMPLETED',
                    'studyFirstPostDateStruct': {'date': '2020-05-01'},
                    'primaryCompletionDateStruct': {'date': '2022-08-15'},
                },
                'designModule': {'studyType': 'INTERVENTIONAL', 'enrollmentInfo': {'count': 500, 'type': 'ACTUAL'}},
                'outcomesModule': {
                    'primaryOutcomes': [{'measure': 'Composite cardiovascular death or myocardial infarction', 'timeFrame': '24 months', 'description': 'MACE'}],
                    'secondaryOutcomes': [{'measure': 'Change in systolic blood pressure from baseline', 'timeFrame': '12 weeks'}],
                },
            }
        }
        rec = pct.fetch_trial_record('nct04567890', transport=lambda nid: (200, study, sha_json(study)))
        self.assertEqual(rec['nctId'], 'NCT04567890')
        self.assertEqual(rec['enrollment'], {'count': 500, 'type': 'ACTUAL'})
        self.assertEqual(len(rec['primaryOutcomes']), 1)

        paper = (
            'A total of 250 patients were enrolled in NCT04567890 (125 per arm). '
            'The primary outcome was change in systolic blood pressure from baseline at 12 weeks.'
        )
        comp = pct.compare_paper_with_registry(paper, [rec])
        item = comp['registryComparisons'][0]
        self.assertIn('potential_outcome_switch', item['flags'])
        self.assertIn('enrollment_discrepancy_candidate', item['flags'])
        self.assertEqual(item['note'], pct.COMPARISON_FRAMING)

    def test_fetch_trial_404_and_invalid_id(self):
        rec_404 = pct.fetch_trial_record('NCT99999999', transport=lambda nid: (404, None, hashlib.sha256(b'404').hexdigest()))
        self.assertEqual(rec_404['status'], 'not_found')
        with self.assertRaises(ValueError):
            pct.fetch_trial_record('NCT123')


class SecurityBoundaryTests(unittest.TestCase):
    def test_rejects_non_global_ips_and_bad_providers(self):
        private_addr = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))]
        with patch.object(socket, 'getaddrinfo', return_value=private_addr):
            with self.assertRaisesRegex(ValueError, 'non_public_api_address'):
                peg.fetch_json('crossref', '/works/10.1000/abc')
            with self.assertRaisesRegex(ValueError, 'non_public_api_address'):
                pct.fetch_study_json('NCT01234567')

        with self.assertRaisesRegex(ValueError, 'unknown_provider'):
            peg.fetch_json('evil.example.com', '/works')


if __name__ == '__main__':
    unittest.main()

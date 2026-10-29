import copy
import unittest
from fetch_artifact import eligible, verify_manifest

class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.repo = 'owner/repo'
        self.run = {'id': 42, 'run_attempt': 1, 'status': 'completed', 'conclusion': 'success', 'workflow_id': 8,
                    'repository': {'full_name': self.repo}, 'head_repository': {'full_name': self.repo},
                    'event': 'push', 'head_branch': 'main', 'head_sha': 'a'*40}
        self.manifest = {'schema': 1, 'platform': 'ubuntu-24.04-x86_64', 'repository': self.repo,
                         'build_commit': 'a'*40, 'tree': 'b'*40, 'run_id': 42, 'run_attempt': 1}
        self.commit = {'sha': 'a'*40, 'tree': {'sha': 'b'*40}, 'parents': []}

    def verify(self):
        verify_manifest(self.manifest, self.run, self.commit, 'b'*40, self.repo)

    def test_successful_main_build_reused_by_content_even_when_merge_sha_differs(self):
        self.assertTrue(eligible(self.run, self.repo, 8))
        self.verify()

    def test_failed_fork_wrong_workflow_or_other_branch_rejected(self):
        for field, value in [('conclusion', 'failure'), ('status', 'in_progress'), ('head_branch', 'unreviewed'),
                             ('workflow_id', 99), ('head_repository', {'full_name': 'fork/repo'})]:
            run = copy.deepcopy(self.run); run[field] = value
            self.assertFalse(eligible(run, self.repo, 8))

    def test_wrong_tree_provenance_and_attempt_rejected(self):
        for field, value in [('tree', 'c'*40), ('run_id', 99), ('run_attempt', 2), ('build_commit', 'd'*40)]:
            manifest = {**self.manifest, field: value}
            with self.assertRaises(RuntimeError):
                verify_manifest(manifest, self.run, self.commit, 'b'*40, self.repo)
        self.commit['tree']['sha'] = 'c'*40
        with self.assertRaises(RuntimeError): self.verify()

    def test_pr_merge_candidate_checks_both_parents(self):
        self.run.update(event='pull_request', pull_requests=[{'base': {'ref': 'online', 'sha': 'c'*40}, 'head': {'sha': 'a'*40}}])
        self.manifest['build_commit'] = self.commit['sha'] = 'd'*40
        self.commit['parents'] = [{'sha': 'c'*40}, {'sha': 'a'*40}]
        self.assertTrue(eligible(self.run, self.repo, 8)); self.verify()
        self.commit['parents'][0]['sha'] = 'e'*40
        with self.assertRaises(RuntimeError): self.verify()

if __name__ == '__main__': unittest.main()

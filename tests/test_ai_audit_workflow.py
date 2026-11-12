import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/ai-audit-readonly.yml").read_text("utf8")


class AuditWorkflowTest(unittest.TestCase):
    def test_default_manual_main_guard_and_isolated_environment(self):
        self.assertIn("workflow_dispatch:", WORKFLOW)
        self.assertIn("confirm_audit == 'AUDIT'", WORKFLOW)
        self.assertIn("github.ref == 'refs/heads/main'", WORKFLOW)
        self.assertIn("environment: aws-ai-audit", WORKFLOW)
        self.assertNotIn("environment: aws-runtime", WORKFLOW)

    def test_assume_only_ai_audit_role(self):
        self.assertIn("vars.AWS_AI_AUDIT_ROLE_ARN", WORKFLOW)
        self.assertIn("ivrm-ai-github-audit-readonly-role", WORKFLOW)
        self.assertIn("mask-aws-account-id: true", WORKFLOW)
        self.assertIn("role-session-name: ivrm-ai-readonly-audit", WORKFLOW)
        self.assertIn("id-token: write", WORKFLOW)
        self.assertNotIn("vars.AWS_ROLE_ARN", WORKFLOW)

    def test_no_write_or_secret_apis(self):
        for action in ["ssm send-command", "ec2 terminate-instances", "ec2 stop-instances",
                       "secretsmanager get-secret-value", "ssm get-parameter",
                       "ecr get-login-password", "docker build", "docker push", "terraform apply",
                       "aws iam create-", "aws s3 cp", "sudo "]:
            with self.subTest(action=action):
                self.assertNotIn(action, WORKFLOW)
        self.assertIn("ec2 describe-instances", WORKFLOW)
        self.assertIn("ssm describe-instance-information", WORKFLOW)
        self.assertIn("cloudwatch describe-alarms", WORKFLOW)

    def test_no_unfiltered_identity_emission(self):
        self.assertNotIn("echo \"$current_account\"", WORKFLOW)
        self.assertNotIn("echo \"$current_arn\"", WORKFLOW)
        self.assertNotIn("aws sts get-caller-identity --output json", WORKFLOW)
        self.assertNotIn("GITHUB_TOKEN", WORKFLOW)


if __name__ == "__main__":
    unittest.main()

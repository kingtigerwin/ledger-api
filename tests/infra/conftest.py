"""Set before anything imports aws_cdk: it starts the Node process behind CDK then, which keeps this environment."""

import json
import os

os.environ.setdefault("JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION", "1")
# Synthesizing a stack would otherwise build the Lambda bundles with uv, which takes seconds per stack; only
# test_python_code.py looks at them, and it turns bundling back on.
os.environ["CDK_CONTEXT_JSON"] = json.dumps({"aws:cdk:bundling-stacks": []})

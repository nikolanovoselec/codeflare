---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Security

> Language-specific security checks for Python

## Secret Management

```python
import os
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ["OPENAI_API_KEY"]  # Raises KeyError if missing
```

## Security Scanning

- Use **bandit** for static security analysis:
  ```bash
  bandit -r src/
  ```

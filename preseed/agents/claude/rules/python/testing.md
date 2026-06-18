---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
# Python Testing

**Important:** Tests run via CI only (GitHub Actions). Do not run test suites locally — the container is resource-constrained. Write tests, push, and verify via `gh run view`.

## Framework

Use **pytest** as the testing framework.

## Coverage (CI only)

```bash
pytest --cov=src --cov-report=term-missing
```

## Test Organization

Use `pytest.mark` for test categorization:

```python
import pytest

@pytest.mark.unit
def test_calculate_total():
    ...

@pytest.mark.integration
def test_database_connection():
    ...
```

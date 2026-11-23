"""Require a complete, passing JUnit receipt for the Host persistence matrix."""

import sys
from pathlib import Path
from xml.etree import ElementTree

SUITE = 'REQ-STOR-002/004/011/031/032: production persistence policy matrix'
TEST_FILE = 'host/__tests__/entrypoint-rclone-filters.test.js'
# 2 policies × 2 session modes × 3 sync modes × 2 curation × 2 immutability,
# plus 12 bootstrap, recovery, validation, and migration cases in the same suite.
EXPECTED_CASES = 60


def check_report(path):
    root = ElementTree.parse(path).getroot()
    suites = list(root.iterfind(f'.//testsuite[@name="{SUITE}"]'))
    if len(suites) != 1:
        raise ValueError(f'expected one completed persistence matrix suite, found {len(suites)}')
    suite = suites[0]
    cases = suite.findall('testcase')
    if len(cases) != EXPECTED_CASES or suite.get('tests') != str(EXPECTED_CASES):
        raise ValueError(f'expected {EXPECTED_CASES} terminal persistence cases, found {len(cases)}')
    names = {case.get('name') for case in cases}
    if len(names) != EXPECTED_CASES or not all(names):
        raise ValueError('expected a unique name for each persistence case')
    if any(suite.get(field) != '0' for field in ('skipped', 'failures', 'errors')) or any(
        not ('/' + case.get('file', '')).endswith('/' + TEST_FILE)
        or case.get('time') is None
        or any(case.find(tag) is not None for tag in ('skipped', 'failure', 'error'))
        for case in cases
    ):
        raise ValueError('expected all persistence cases to pass in the owning test file')


if __name__ == '__main__':
    try:
        check_report(Path(sys.argv[1]))
    except (OSError, ElementTree.ParseError, ValueError) as error:
        sys.exit(f'Host persistence JUnit report incomplete: {error}')
    print(f'Host persistence matrix: all {EXPECTED_CASES} cases passed.')

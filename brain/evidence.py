"""Parse captured reports without treating a model's prose as a result."""
import hashlib
import xml.etree.ElementTree as ET


def summarize_junit(reports):
    summary = {'reports': [], 'invalidReports': [], 'tests': 0, 'failures': 0, 'errors': 0, 'skipped': 0,
               'failedTests': []}
    for report in reports:
        name = report.get('path', '<unknown>')
        try:
            if report.get('error'):
                raise ValueError(report['error'])
            xml = report['xml']
            if '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper():
                raise ValueError('DTD is forbidden')
            root = ET.fromstring(xml)
            suites = [root] if root.tag == 'testsuite' else list(root.iter('testsuite'))
            if not suites:
                raise ValueError('No JUnit testsuite')
            counts = {k: sum(int(s.attrib.get(k, '0')) for s in suites) for k in ['tests', 'failures', 'errors', 'skipped']}
            if any(v < 0 for v in counts.values()) or counts['failures'] + counts['errors'] + counts['skipped'] > counts['tests']:
                raise ValueError('Invalid JUnit counts')
            for key, value in counts.items():
                summary[key] += value
            for suite in suites:
                for case in suite.iter('testcase'):
                    if case.find('failure') is not None or case.find('error') is not None:
                        summary['failedTests'].append('.'.join(filter(None, [case.attrib.get('classname'), case.attrib.get('name')])))
            summary['reports'].append({'path': name, 'sha256': hashlib.sha256(xml.encode()).hexdigest(), **counts, 'xml': xml})
        except (ValueError, KeyError, TypeError, ET.ParseError) as error:
            summary['invalidReports'].append({'path': name, 'error': str(error)[:300]})
    return summary


def passing_junit(summary):
    return bool(summary['reports']) and summary['tests'] > summary['skipped'] and not any(
        [summary['failures'], summary['errors'], summary['invalidReports']])

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const workflowPath = join(
  import.meta.dir,
  '..',
  '.github/workflows/macos-signing-identity-probe.yml'
);

function stepBlock(workflow: string, name: string) {
  const marker = `\n      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Workflow step is missing: ${name}`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.indexOf('\n      - name: ');
  return next < 0 ? rest : rest.slice(0, next);
}

describe('protected macOS signing identity probe', () => {
  test('is manual, protected, short, and unable to publish or execute repository code', async () => {
    const workflow = await readFile(workflowPath, 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('push:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow).toContain('permissions: {}');
    expect(workflow).toContain(
      "if: github.repository == 'DotNaos/project-space' && github.ref == 'refs/heads/main'"
    );
    expect(workflow).toContain('runs-on: macos-15');
    expect(workflow).toContain('timeout-minutes: 5');
    expect(workflow).toContain('environment: release-signing');
    expect(workflow.match(/^\s*uses:/gm)).toHaveLength(1);
    expect(workflow).toContain(
      'uses: 1password/load-secrets-action@3a12b0ab99d9cd590a3e9b5a90ea017210ed9556'
    );
    expect(workflow).toContain("version: '2.35.0'");

    for (const forbidden of [
      'actions/checkout@',
      'upload-artifact@',
      'download-artifact@',
      'setup-bun@',
      'setup-go@',
      'GITHUB_WORKSPACE',
      'gh release',
      'gh api',
      'GITHUB_API',
      'project deploy',
      'packaging/',
      'bun ',
      'go build',
      'swiftc ',
      'set -x',
      'printenv',
      'eval '
    ]) {
      expect(workflow).not.toContain(forbidden);
    }
  });

  test('proves one Developer ID identity by signing only a temporary system binary copy', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const exercise = stepBlock(
      workflow,
      'Exercise identity in a disposable default keychain'
    );

    expect(exercise).toContain('/bin/cp -X /usr/bin/true "$probe_binary"');
    expect(exercise).toContain('identity_count == 1');
    expect(exercise).toContain('[[ $leaf_fingerprint == "$identity" ]]');
    expect(exercise).toContain('1.2.840.113635.100.6.1.13');
    expect(exercise).toContain('certificate 1[field.1.2.840.113635.100.6.2.6] exists');
    expect(exercise).toContain('certificate leaf[subject.OU] = \"R72P4M9WMS\"');
    expect(exercise).toContain('--keychain "$keychain" --sign "$identity_label"');
    expect(exercise).toContain('--timestamp=none "$probe_binary"');
    expect(exercise).toContain('--test-requirement "$requirement"');
    expect(exercise).toContain('2>"$codesign_diagnostics"');
    expect(exercise).toContain('>"$import_diagnostics" 2>&1');
    expect(exercise).not.toContain('cat "$codesign_diagnostics"');
    expect(exercise).not.toContain('cat "$import_diagnostics"');
    expect(exercise).not.toContain('security import "$pem"');
    expect(exercise).not.toMatch(/security import[^\n]*\s-A(?:\s|$)/);
  });

  test('switches the default only after validation and restores every reference before deletion', async () => {
    const workflow = await readFile(workflowPath, 'utf8');
    const exercise = stepBlock(
      workflow,
      'Exercise identity in a disposable default keychain'
    );
    const confirm = stepBlock(workflow, 'Confirm probe identity cleanup');

    const validate = exercise.indexOf('Validated one protected Developer ID Application identity.');
    const partition = exercise.indexOf('security set-key-partition-list');
    const activate = exercise.indexOf('security default-keychain -d user -s "$keychain"');
    const sign = exercise.indexOf('/usr/bin/codesign --force');
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(partition);
    expect(partition).toBeLessThan(activate);
    expect(activate).toBeLessThan(sign);

    const trapRestore = exercise.indexOf(
      'security default-keychain -d user -s "$original_default"'
    );
    const trapDelete = exercise.indexOf('security delete-keychain "$keychain"');
    expect(trapRestore).toBeGreaterThan(-1);
    expect(trapRestore).toBeLessThan(trapDelete);
    expect(confirm).toContain('if: always()');
    expect(confirm.indexOf('default-keychain -d user -s "$original_default"')).toBeLessThan(
      confirm.indexOf('delete-keychain "$keychain"')
    );
    expect(confirm).toContain('[[ $current_default != "$keychain" ]]');
    expect(confirm).toContain('[[ $line != "$keychain" ]]');
    expect(workflow).not.toContain('login.keychain');
  });
});

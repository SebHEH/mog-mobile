#!/usr/bin/env python3
"""
deploy.py - push the local apps-script/ folder to one or more bound Apps
Script projects, optionally bumping each Sheet's web-app deployment so the
/exec URL the PWA hits serves the new code.

Reads apps-script/.clasp-targets.json. For each target, writes a temporary
apps-script/.clasp.json pointing at that target's scriptId and runs
`clasp push -f` from inside apps-script/. With --redeploy, also runs
`clasp deploy --deploymentId <id>` per target to publish a new version
under each Sheet's existing /exec URL.

Two distinct concepts to keep straight:
  - Source push (clasp push): updates the script project. Bound sidebars
    (ManageVendors.html, ManageItems.html, etc.) read from HEAD and pick up
    changes on next sidebar open. THIS IS THE DEFAULT.
  - Web-app redeploy (clasp deploy --deploymentId <id>): bumps the version
    served at each Sheet's /exec URL, which is what the PWA actually calls.
    REQUIRED when MOGApi.gs changes — pushes alone don't reach the /exec URL.
    Use --redeploy. When unsure, just pass --redeploy (~3s extra per target).

Discovery mode (--discover) loops the targets and finds each Sheet's
highest-versioned non-@HEAD deployment, then prints a JSON snippet you can
paste into .clasp-targets.json. Use once per fresh checkout if the
deploymentId fields contain "FILL_ME_IN", or after onboarding a new store.

Prerequisites:
  - Node.js LTS installed
  - clasp installed globally:  npm install -g @google/clasp
  - Logged in once:            clasp login
  - apps-script/.clasp-targets.json filled in with real Script IDs
  - For --redeploy: deploymentIds populated too (run --discover if not)

Usage:
  python deploy.py                              push to all targets
  python deploy.py --target rpr                 push to one target
  python deploy.py --redeploy                   push + redeploy all targets
  python deploy.py --redeploy --description "Dashboard cache"
                                                push + tagged redeploy
  python deploy.py --dry-run                    preview push
  python deploy.py --dry-run --redeploy         preview push + redeploy
  python deploy.py --discover                   find all deploymentIds
  python deploy.py --discover --target tnytf    find one deploymentId
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
APPS_SCRIPT_DIR = os.path.join(ROOT, 'apps-script')
TARGETS_FILE    = os.path.join(APPS_SCRIPT_DIR, '.clasp-targets.json')
CLASP_FILE      = os.path.join(APPS_SCRIPT_DIR, '.clasp.json')


def die(msg, code=1):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(code)


def find_clasp():
    """Locate the clasp executable. On Windows npm installs it as clasp.cmd."""
    path = shutil.which('clasp')
    if not path:
        die("'clasp' not found on PATH. Install with: npm install -g @google/clasp")
    return path


def load_targets(target_filter=None):
    if not os.path.exists(TARGETS_FILE):
        die(TARGETS_FILE + ' not found.')
    with open(TARGETS_FILE, 'r', encoding='utf-8') as f:
        targets = json.load(f)
    if target_filter:
        targets = [t for t in targets if t.get('slug') == target_filter]
        if not targets:
            die("no target with slug '" + target_filter + "' in .clasp-targets.json")
    return targets


def check_placeholder_script_ids(targets):
    bad = [t for t in targets if not t.get('scriptId') or t.get('scriptId') == 'FILL_ME_IN']
    if bad:
        print('ERROR: these targets still have a placeholder Script ID:', file=sys.stderr)
        for t in bad:
            print('  - ' + t.get('slug', '?') + ' (' + t.get('label', '?') + ')', file=sys.stderr)
        print("Edit apps-script/.clasp-targets.json and replace FILL_ME_IN with each Sheet's real Script ID.", file=sys.stderr)
        print("(In the Sheet: Extensions > Apps Script > Project Settings > Script ID)", file=sys.stderr)
        sys.exit(1)


def check_placeholder_deployment_ids(targets):
    """Only enforced when --redeploy is set."""
    bad = [
        t for t in targets
        if not t.get('isTemplate') and (
            not t.get('deploymentId') or t.get('deploymentId') == 'FILL_ME_IN'
        )
    ]
    if bad:
        print('ERROR: --redeploy requested but these targets are missing a deploymentId:', file=sys.stderr)
        for t in bad:
            print('  - ' + t.get('slug', '?') + ' (' + t.get('label', '?') + ')', file=sys.stderr)
        print('Run: python deploy.py --discover', file=sys.stderr)
        print('Paste the printed IDs into apps-script/.clasp-targets.json.', file=sys.stderr)
        sys.exit(1)


def write_clasp_json(script_id):
    """Write apps-script/.clasp.json pointing at this target's script."""
    payload = {'scriptId': script_id, 'rootDir': '.'}
    with open(CLASP_FILE, 'w', encoding='utf-8') as f:
        json.dump(payload, f)


def cleanup_clasp_json():
    if os.path.exists(CLASP_FILE):
        try:
            os.remove(CLASP_FILE)
        except OSError:
            pass


def run_clasp(clasp_path, args, capture_output=False):
    """Run clasp from inside apps-script/. Returns (exit_code, stdout, stderr)."""
    result = subprocess.run(
        [clasp_path] + args,
        cwd=APPS_SCRIPT_DIR,
        capture_output=capture_output,
        text=True,
    )
    return result.returncode, result.stdout, result.stderr


def push_target(clasp_path, target):
    write_clasp_json(target['scriptId'])
    code, _, _ = run_clasp(clasp_path, ['push', '-f'])
    if code == 0:
        print('PUSH OK: ' + target['slug'])
        return 'ok'
    print('PUSH FAILED: ' + target['slug'] + ' (exit ' + str(code) + ')', file=sys.stderr)
    return 'fail (exit ' + str(code) + ')'


def redeploy_target(clasp_path, target, description):
    deployment_id = target.get('deploymentId')
    if not deployment_id:
        print('DEPLOY SKIPPED: ' + target['slug'] + ' (no deploymentId)')
        return 'skipped'
    args = ['deploy', '--deploymentId', deployment_id]
    if description:
        args += ['--description', description]
    code, _, _ = run_clasp(clasp_path, args)
    if code == 0:
        print('DEPLOY OK: ' + target['slug'])
        return 'ok'
    print('DEPLOY FAILED: ' + target['slug'] + ' (exit ' + str(code) + ')', file=sys.stderr)
    return 'fail (exit ' + str(code) + ')'


DEPLOYMENT_LINE_RE = re.compile(r'^\s*-\s+(\S+)\s+@(\d+)')


def discover_target(clasp_path, target):
    """Run `clasp deployments` and return the highest-versioned non-@HEAD id, or None."""
    write_clasp_json(target['scriptId'])
    code, stdout, stderr = run_clasp(clasp_path, ['deployments'], capture_output=True)
    if code != 0:
        print('FAILED: clasp deployments exit ' + str(code), file=sys.stderr)
        if stdout:
            print(stdout)
        if stderr:
            print(stderr, file=sys.stderr)
        return None
    best_id, best_version = None, -1
    for line in stdout.splitlines():
        m = DEPLOYMENT_LINE_RE.match(line)
        if m:
            version = int(m.group(2))
            if version > best_version:
                best_version = version
                best_id = m.group(1)
    if best_id:
        print('Found deployment @' + str(best_version) + ': ' + best_id)
    else:
        print('No versioned web-app deployment found for this Sheet.')
        print('Output was:')
        print(stdout)
    return best_id


def print_summary(results):
    print('')
    print('=== Summary ===')
    # Plain text table — keep deps zero.
    slugs = [r['slug'] for r in results]
    width = max([len(s) for s in slugs] + [4])
    print('slug'.ljust(width) + '  push        redeploy')
    print('-' * (width + 22))
    for r in results:
        print(r['slug'].ljust(width) + '  ' + r['push'].ljust(10) + '  ' + r['redeploy'])


def cmd_deploy(args, clasp_path):
    """Push (and optionally redeploy) to selected targets."""
    targets = load_targets(args.target)
    check_placeholder_script_ids(targets)
    if args.redeploy:
        check_placeholder_deployment_ids(targets)

    results = []
    try:
        for t in targets:
            print('')
            print('=== ' + t['slug'] + ' (' + t.get('label', '') + ') ===')
            print('Script ID: ' + t['scriptId'])
            if args.redeploy and t.get('deploymentId'):
                print('Deployment ID: ' + t['deploymentId'])

            if args.dry_run:
                print('[dry run] would: clasp push -f')
                redeploy_status = 'n/a'
                if args.redeploy:
                    if t.get('deploymentId'):
                        desc = ''
                        if args.description:
                            desc = ' --description "' + args.description + '"'
                        print('[dry run] would: clasp deploy --deploymentId ' + t['deploymentId'] + desc)
                        redeploy_status = 'dry-run'
                    else:
                        print('[dry run] would: SKIP redeploy (no deploymentId, e.g. template)')
                        redeploy_status = 'skipped'
                results.append({'slug': t['slug'], 'push': 'dry-run', 'redeploy': redeploy_status})
                continue

            push_status = push_target(clasp_path, t)
            redeploy_status = 'n/a'
            if args.redeploy and push_status == 'ok':
                redeploy_status = redeploy_target(clasp_path, t, args.description)
            results.append({'slug': t['slug'], 'push': push_status, 'redeploy': redeploy_status})
    finally:
        cleanup_clasp_json()

    print_summary(results)

    failed = [
        r for r in results
        if r['push'] not in ('ok', 'dry-run')
        or r['redeploy'] not in ('ok', 'dry-run', 'skipped', 'n/a')
    ]
    if failed:
        sys.exit(1)


def cmd_discover(args, clasp_path):
    """Find deploymentIds for non-template targets."""
    targets = load_targets(args.target)
    targets = [t for t in targets if not t.get('isTemplate')]
    if not targets:
        die('no non-template targets to discover.')
    check_placeholder_script_ids(targets)

    discovered = []
    try:
        for t in targets:
            print('')
            print('=== ' + t['slug'] + ' (' + t.get('label', '') + ') ===')
            dep_id = discover_target(clasp_path, t)
            discovered.append({'slug': t['slug'], 'deploymentId': dep_id})
    finally:
        cleanup_clasp_json()

    print('')
    print('=== Discovered deployment IDs ===')
    print('Paste these into the matching entries in apps-script/.clasp-targets.json:')
    print('')
    for d in discovered:
        if d['deploymentId']:
            print('  "' + d['slug'] + '": "deploymentId": "' + d['deploymentId'] + '"')
        else:
            print('  "' + d['slug'] + '": (not found - check the Sheet has a published web-app deployment)')


def main():
    parser = argparse.ArgumentParser(
        description='Push (and optionally redeploy) the apps-script/ folder to bound Apps Script projects.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            'When to use --redeploy:\n'
            '  Bound-sidebar-only change (ManageVendors.html, ManageItems.html, OrderHistory.html,\n'
            '  etc., and the .gs functions called from those sidebars): NO. Push alone is enough.\n'
            '  Any change to MOGApi.gs or any api_* function the PWA calls: YES, --redeploy required.\n'
            '  Unsure: pass --redeploy. ~3s extra per target.\n'
        ),
    )
    parser.add_argument('--target', help='Slug of a single target to push to. Default: all.')
    parser.add_argument('--dry-run', action='store_true', help='Preview without running clasp.')
    parser.add_argument('--redeploy', action='store_true',
                        help='After pushing, bump each web-app deployment (skipped for template).')
    parser.add_argument('--description', help='Description tag for --redeploy (passed to clasp deploy).')
    parser.add_argument('--discover', action='store_true',
                        help='Discovery mode: print deploymentIds to paste into .clasp-targets.json.')
    args = parser.parse_args()

    if args.description and not args.redeploy:
        die('--description only makes sense with --redeploy.')

    clasp_path = find_clasp()

    if args.discover:
        cmd_discover(args, clasp_path)
    else:
        cmd_deploy(args, clasp_path)


if __name__ == '__main__':
    main()

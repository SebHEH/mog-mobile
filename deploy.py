#!/usr/bin/env python3
"""
deploy.py - push mail-relay/ to the mail relay's Apps Script project and
redeploy its one web-app deployment, so the /exec address Supabase's nightly
close calls never changes.

The mail relay is the only Apps Script MOG still deploys. The stores' own
projects (one per Google Sheet) were retired in Sheet retirement step 5
(2026-11-20): their web-app deployments were archived, the Sheets stay in
Drive frozen, and apps-script/ is now only a source for build.py (the
order math in every store page, the editor pages, the nightly close's shared
code) and for the gates. Their targets (.clasp-targets.json), --target,
--redeploy and --discover are gone; this script refuses them with a pointer.

The relay's IDs are in mail-relay/relay-target.json. It is a standalone
project, bound to no Sheet: Supabase's nightly close (the Edge Function
`close`) sends every recap email through it.

Prerequisites:
  - Node.js LTS installed
  - clasp installed globally:  npm install -g @google/clasp
  - Logged in once:            clasp login

Git check (two maintainers): the deploy first fetches origin/main and refuses
if this copy is missing commits from it, and refuses uncommitted changes in
mail-relay/. --skip-git-check bypasses that (emergencies only).

Usage:
  python deploy.py --relay                      push mail-relay/ and redeploy it
  python deploy.py --relay --dry-run            preview that
  python deploy.py --relay --description "Retry on 429"
                                                tag the new version
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
RELAY_DIR         = os.path.join(ROOT, 'mail-relay')
RELAY_TARGET_FILE = os.path.join(RELAY_DIR, 'relay-target.json')
RELAY_CLASP_FILE  = os.path.join(RELAY_DIR, '.clasp.json')

RETIRED = ('the stores\' Apps Script deploys were retired in Sheet retirement step 5 (2026-11-20):\n'
           '  their /exec deployments are archived and nothing deploys to the Sheets any more.\n'
           '  A change under apps-script/ ships with python build.py and a git push (skill mog-deploy-workflow).\n'
           '  The only Apps Script deploy left is the mail relay: python deploy.py --relay')


def die(msg, code=1):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(code)


def find_clasp():
    """Locate the clasp executable. On Windows npm installs it as clasp.cmd."""
    path = shutil.which('clasp')
    if not path:
        die("'clasp' not found on PATH. Install with: npm install -g @google/clasp")
    return path


def run_clasp(clasp_path, args, cwd):
    """Run clasp in cwd. Returns its exit code."""
    return subprocess.run([clasp_path] + args, cwd=cwd, text=True).returncode


def git(*args):
    """Run a git command in the repo; return (exit code, stdout stripped)."""
    try:
        r = subprocess.run(['git'] + list(args), cwd=ROOT, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return 1, ''
    return r.returncode, r.stdout.strip()


def check_not_behind():
    """Refuse a copy that is missing commits from origin/main."""
    code, _ = git('fetch', '--quiet', 'origin', 'main')
    if code != 0:
        print('WARNING: could not reach GitHub (git fetch failed); checking against the last fetch.')
    code, behind = git('rev-list', '--count', 'HEAD..origin/main')
    if code == 0 and behind not in ('', '0'):
        die('this copy is missing ' + behind + ' commit(s) that are on origin/main.\n'
            '  Deploying now could put an older relay back.\n'
            '  Run git pull (or merge main into your branch), then deploy again.')


def cmd_relay(args):
    """Push mail-relay/ to its own project and redeploy its one deployment
    (Supabase's nightly recap sender; the address never changes)."""
    if not os.path.exists(RELAY_TARGET_FILE):
        die(RELAY_TARGET_FILE + ' not found.')
    with open(RELAY_TARGET_FILE, 'r', encoding='utf-8') as f:
        target = json.load(f)
    script_id, deployment_id = target.get('scriptId'), target.get('deploymentId')
    if not script_id or script_id == 'FILL_ME_IN' or not deployment_id or deployment_id == 'FILL_ME_IN':
        die('mail-relay/relay-target.json has no scriptId or deploymentId yet.\n'
            '  The relay is created once by hand (docs/MOG_ProjectNotes.md, Supabase: "The mail relay").')
    print('=== mail relay (' + target.get('label', '') + ') ===')
    print('Script ID: ' + script_id)
    print('Deployment ID: ' + deployment_id)
    print('Address: https://script.google.com/macros/s/' + deployment_id + '/exec')
    if args.dry_run:
        print('[dry run] would: clasp push -f, then clasp redeploy ' + deployment_id)
        return
    clasp_path = find_clasp()
    if args.skip_git_check:
        print('WARNING: --skip-git-check: not comparing with origin/main.')
    else:
        check_not_behind()
        _, dirty = git('status', '--porcelain', '--', 'mail-relay')
        if dirty:
            die('mail-relay/ has uncommitted changes; commit them first, so what the relay runs is in git:\n' + dirty)
    with open(RELAY_CLASP_FILE, 'w', encoding='utf-8') as f:
        json.dump({'scriptId': script_id, 'rootDir': '.'}, f)
    try:
        if run_clasp(clasp_path, ['push', '-f'], RELAY_DIR) != 0:
            die('PUSH FAILED: mail relay')
        print('PUSH OK: mail relay')
        args_deploy = ['deploy', '--deploymentId', deployment_id]
        if args.description:
            args_deploy += ['--description', args.description]
        if run_clasp(clasp_path, args_deploy, RELAY_DIR) != 0:
            die('DEPLOY FAILED: mail relay')
        print('DEPLOY OK: mail relay')
    finally:
        if os.path.exists(RELAY_CLASP_FILE):
            try:
                os.remove(RELAY_CLASP_FILE)
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser(
        description='Push mail-relay/ (the nightly recap sender) and redeploy it. The only Apps Script deploy left.')
    parser.add_argument('--relay', action='store_true', help='Push mail-relay/ and redeploy it (required).')
    parser.add_argument('--dry-run', action='store_true', help='Preview without running clasp.')
    parser.add_argument('--description', help='Description tag for the new relay version.')
    parser.add_argument('--skip-git-check', action='store_true',
                        help='Deploy without comparing this copy with origin/main (emergencies only).')
    # Retired with the store deploys; kept only to answer with a pointer.
    parser.add_argument('--target', help=argparse.SUPPRESS)
    parser.add_argument('--redeploy', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--discover', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.target or args.redeploy or args.discover or not args.relay:
        die(RETIRED)
    cmd_relay(args)


if __name__ == '__main__':
    main()

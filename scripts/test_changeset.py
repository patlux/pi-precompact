"""Standard-library and real Git tests, adapted from tws/Zugriff. No live repos changed."""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("changeset.py")
REPO = SCRIPT.parent.parent
SPEC = importlib.util.spec_from_file_location("changeset", SCRIPT)
assert SPEC and SPEC.loader
cs = importlib.util.module_from_spec(SPEC)
sys.modules["changeset"] = cs
SPEC.loader.exec_module(cs)
TODAY = dt.date(2026, 10, 25)
NOW = dt.datetime(2026, 10, 25, 9, 30, tzinfo=dt.UTC)


class ParseTests(unittest.TestCase):
    def test_typed_empty_and_crlf(self):
        note = cs.parse_changeset("a.md", '---\r\ntype: "fixed"\r\nbump: patch\r\n---\r\n\r\nKeep drafts.\r\n')
        self.assertEqual((note.type, note.bump, note.summary), ("fixed", "patch", "Keep drafts."))
        self.assertIsNone(cs.parse_changeset("b.md", "---\n---\n").bump)

    def test_invalid_frontmatter(self):
        for value in ("none", "---\ntype: fixed", "---\n---\ntext", "---\ntype: fixed\n---\ntext",
                      "---\ntype: bad\nbump: patch\n---\ntext", "---\ntype: fixed\nbump: bad\n---\ntext",
                      "---\ntype: fixed\nbump: patch\n---\n", "---\ntype: fixed\nbump: patch\nscope: app\n---\ntext",
                      "---\ntype: fixed\nbump: patch\nbump: major\n---\ntext"):
            with self.subTest(value=value), self.assertRaises(cs.ChangesetError):
                cs.parse_changeset("bad.md", value)

    def test_direct_markdown_only(self):
        self.assertTrue(cs.is_changeset_path(".changeset/a.md"))
        for name in (".changeset/README.md", ".changeset/nested/a.md", "other/a.md", ".changeset/a.txt"):
            self.assertFalse(cs.is_changeset_path(name))

    def test_highest_semver_bump_wins(self):
        notes = [cs.Changeset("empty.md", None, None, "")]
        self.assertIsNone(cs.next_version("1.1.7", notes))
        for bump, expected in (("patch", "1.1.8"), ("minor", "1.2.0"), ("major", "2.0.0")):
            notes.append(cs.Changeset(f"{bump}.md", "changed", bump, "Summary"))
            self.assertEqual(cs.next_version("1.1.7", notes), expected)
        self.assertEqual(cs.next_version("0.3.9", notes), "1.0.0")

    def test_invalid_versions_and_json(self):
        for version in ("1.2", "01.2.3", "1.2.3-beta.1", "1.2.3+build", "1.2.3\n"):
            with self.subTest(version=version), self.assertRaises(cs.ChangesetError):
                cs.next_version(version, [])
        for value in ('[]', '{"version":"1.0.0","version":"2.0.0"}', '{broken'):
            with self.subTest(value=value), self.assertRaises((cs.ChangesetError, json.JSONDecodeError)):
                cs.read_version(value)


class RepoTests(unittest.TestCase):
    def setUp(self):
        # Hook-exported Git variables must never redirect fixture operations.
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        context = patch.dict(os.environ, env, clear=True)
        context.start()
        self.addCleanup(context.stop)
        temp = tempfile.TemporaryDirectory(prefix="pi-background-changeset-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.write_json("package.json", {"name": "pi-fixture", "version": "1.1.7", "private": True})
        self.write_json("package-lock.json", {
            "name": "pi-fixture", "version": "1.1.7", "lockfileVersion": 3,
            "packages": {"": {"name": "pi-fixture", "version": "1.1.7"},
                         "node_modules/external": {"version": "1.1.7", "integrity": "fixture-only"}},
        })
        self.write("CHANGELOG.md", cs.CHANGELOG_HEADER)
        self.write(".changeset/README.md", "Instructions\n")
        self.write("scripts/changeset.py", SCRIPT.read_text())
        self.write(".githooks/pre-commit", (REPO / ".githooks/pre-commit").read_text())
        self.commit("init")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True).stdout

    def cli(self, *args, check=True):
        return subprocess.run([sys.executable, str(self.root / "scripts/changeset.py"), *args], cwd=self.root,
                              check=check, capture_output=True, text=True)

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return target

    def write_json(self, path, value):
        return self.write(path, json.dumps(value, indent=2) + "\n")

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def note(self, kind="fixed", bump="patch", summary="Keep drafts."):
        return cs.add(self.root, kind, bump, summary, NOW)

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*")
                if p.is_file() and ".git" not in p.relative_to(self.root).parts}

    def test_add_slug_collision_and_empty(self):
        first = self.note(summary="Frühstück für alle")
        self.assertEqual(first.name, "20261025-093000-fruhstuck-fur-alle.md")
        self.assertNotEqual(first, self.note(summary="Frühstück für alle"))
        self.assertEqual(cs.add(self.root, None, None, "", NOW).read_text(), "---\n---\n")
        with self.assertRaises(cs.ChangesetError):
            cs.add(self.root, None, "patch", "", NOW)

    def test_hook_checks_staged_not_worktree(self):
        self.write("code.ts", "one\n")
        self.git("add", "code.ts")
        with self.assertRaisesRegex(cs.ChangesetError, "no changeset"):
            cs.check_staged(self.root)
        note = self.note()
        self.git("add", ".changeset")
        note.write_text("invalid unstaged content")
        self.assertIn(note.name, cs.check_staged(self.root))
        self.git("add", ".changeset")
        with self.assertRaises(cs.ChangesetError):
            cs.check_staged(self.root)

    def test_old_note_is_not_new_and_modified_notes_are_validated(self):
        note = self.note()
        self.commit("change")
        note.write_text(note.read_text().replace("Keep drafts.", "New text."))
        self.git("add", ".changeset")
        with self.assertRaisesRegex(cs.ChangesetError, "no changeset"):
            cs.check_staged(self.root)
        note.write_text("invalid")
        cs.add(self.root, None, None, "", NOW)
        self.git("add", ".changeset")
        with self.assertRaises(cs.ChangesetError):
            cs.check_staged(self.root)

    def test_real_hook_rejects_missing_note_accepts_empty_and_amend(self):
        hook = cs.install_hook(self.root)
        self.assertTrue(hook.stat().st_mode & 0o111)
        self.assertEqual(cs.install_hook(self.root), hook)
        self.write("code.ts", "one\n")
        with self.assertRaises(subprocess.CalledProcessError) as error:
            self.commit("missing")
        self.assertIn("no changeset", error.exception.stderr)
        cs.add(self.root, None, None, "", NOW)
        self.commit("empty note")
        self.write("code.ts", "two\n")
        self.git("commit", "-q", "-a", "--amend", "--no-edit")
        self.assertEqual(self.git("show", "HEAD:code.ts"), "two\n")
        self.write("code.ts", "three\n")
        with self.assertRaises(subprocess.CalledProcessError):
            self.git("commit", "-q", "-a", "-m", "missing again")

    def test_root_commit_and_amend(self):
        root = self.root / "fresh"
        root.mkdir()
        cs.git(root, "init", "-q", "-b", "main")
        cs.git(root, "config", "user.email", "test@example.invalid")
        cs.git(root, "config", "user.name", "Test")
        (root / "scripts").mkdir()
        (root / "scripts/changeset.py").write_text(SCRIPT.read_text())
        hook = root / ".git/hooks/pre-commit"
        hook.write_text((REPO / ".githooks/pre-commit").read_text())
        hook.chmod(0o755)
        cs.add(root, None, None, "", NOW)
        cs.git(root, "add", "-A")
        cs.git(root, "commit", "-q", "-m", "root")
        cs.git(root, "commit", "-q", "--amend", "--no-edit")

    def test_existing_hook_and_manager_are_preserved(self):
        hook = self.write(".git/hooks/pre-commit", "#!/bin/sh\nexit 7\n")
        with self.assertRaisesRegex(cs.ChangesetError, "existing hook"):
            cs.install_hook(self.root)
        self.assertEqual(hook.read_text(), "#!/bin/sh\nexit 7\n")
        self.git("config", "core.hooksPath", ".custom-hooks")
        with self.assertRaisesRegex(cs.ChangesetError, "core.hooksPath"):
            cs.install_hook(self.root)

    def test_symlink_note_is_rejected(self):
        (self.root / ".changeset/link.md").symlink_to("../CHANGELOG.md")
        self.git("add", ".changeset")
        with self.assertRaisesRegex(cs.ChangesetError, "regular"):
            cs.check_staged(self.root)
        with self.assertRaisesRegex(cs.ChangesetError, "symlinks"):
            cs.pending(self.root)

    def test_merge_uses_branch_notes(self):
        cs.install_hook(self.root)
        self.git("switch", "-q", "-c", "feature")
        self.note("added", "minor", "Feature.")
        self.commit("feature")
        self.git("switch", "-q", "main")
        self.git("merge", "--no-ff", "--no-commit", "feature")
        self.assertIn("merge commit", cs.check_staged(self.root))
        self.git("commit", "-q", "-m", "merge")

    def test_release_root_versions_history_and_hook(self):
        cs.install_hook(self.root)
        self.note()
        self.note("added", "minor", "Photos\nwith a cutout.")
        cs.add(self.root, None, None, "", NOW)
        self.commit("changes")
        old_lock = json.loads((self.root / "package-lock.json").read_text())
        self.assertEqual(cs.release(self.root, TODAY), "1.2.0")
        self.assertEqual(cs.pending(self.root), [])
        self.assertTrue((self.root / ".changeset/README.md").exists())
        old_lock["version"] = old_lock["packages"][""]["version"] = "1.2.0"
        self.assertEqual(json.loads((self.root / "package-lock.json").read_text()), old_lock)
        self.assertEqual(json.loads((self.root / "package.json").read_text()), {"name": "pi-fixture", "version": "1.2.0", "private": True})
        first = (self.root / "CHANGELOG.md").read_text()
        self.assertIn("### Added\n\n- Photos\n  with a cutout.\n\n### Fixed\n\n- Keep drafts.\n", first)
        self.git("add", "-A")
        self.assertEqual(cs.check_staged(self.root), "release 1.2.0")
        self.git("commit", "-q", "-m", "version bump to v1.2.0")
        self.git("commit", "-q", "--amend", "--no-edit")
        self.note("changed", "major", "Breaking change.")
        self.commit("breaking")
        self.assertEqual(cs.release(self.root, TODAY), "2.0.0")
        changelog = (self.root / "CHANGELOG.md").read_text()
        self.assertLess(changelog.index("## 2.0.0"), changelog.index("## 1.2.0"))
        self.assertTrue(changelog.endswith(first[first.index("## 1.2.0"):]))

    def test_empty_dirty_and_nonmain_refuse_without_writes(self):
        cs.add(self.root, None, None, "", NOW)
        self.commit("empty")
        for state, error in (("empty", "nothing to release"), ("dirty", "clean working tree"), ("branch", "main only")):
            if state == "dirty":
                self.note()
            if state == "branch":
                self.commit("note")
                self.git("switch", "-q", "-c", "feature")
            before = self.snapshot()
            with self.assertRaisesRegex(cs.ChangesetError, error):
                cs.release(self.root, TODAY)
            self.assertEqual(self.snapshot(), before)

    def test_lock_mismatch_missing_root_and_workspace_refuse_without_writes(self):
        self.note()
        original = json.loads((self.root / "package-lock.json").read_text())
        for case in ("mismatch", "missing", "workspace"):
            lock = json.loads(json.dumps(original))
            if case == "mismatch":
                lock["packages"][""]["version"] = "9.0.0"
            if case == "missing":
                del lock["packages"][""]
            if case == "workspace":
                self.write_json("package.json", {"name": "pi-fixture", "version": "1.1.7", "workspaces": []})
            self.write_json("package-lock.json", lock)
            self.commit(case)
            before = self.snapshot()
            with self.assertRaises(cs.ChangesetError):
                cs.release(self.root, TODAY)
            self.assertEqual(self.snapshot(), before)

    def test_duplicate_changelog_refuses_without_writes(self):
        self.note()
        self.write("CHANGELOG.md", cs.CHANGELOG_HEADER + "\n## 1.1.8 - 2026-10-24\n")
        self.commit("duplicate")
        before = self.snapshot()
        with self.assertRaisesRegex(cs.ChangesetError, "already has a section"):
            cs.release(self.root, TODAY)
        self.assertEqual(self.snapshot(), before)

    def test_release_exemption_rejects_unrelated_work_incomplete_bumps_wrong_notes(self):
        self.note()
        self.commit("change")
        cs.release(self.root, TODAY)
        extra = self.write("unrelated.ts", "unrelated\n")
        self.git("add", "-A")
        with self.assertRaisesRegex(cs.ChangesetError, "only the version"):
            cs.check_staged(self.root)
        extra.unlink()
        lock = (self.root / "package-lock.json").read_text()
        self.write("package-lock.json", lock.replace('"1.1.8"', '"1.1.7"'))
        self.git("add", "-A")
        with self.assertRaises(cs.ChangesetError):
            cs.check_staged(self.root)
        self.write("package-lock.json", lock)
        self.write("CHANGELOG.md", (self.root / "CHANGELOG.md").read_text().replace("Keep drafts.", "Invented note."))
        self.git("add", "-A")
        with self.assertRaisesRegex(cs.ChangesetError, "does not match"):
            cs.check_staged(self.root)

    def test_empty_note_cannot_hide_manual_or_lock_only_bumps(self):
        cs.add(self.root, None, None, "", NOW)
        for filename in ("package-lock.json", "package.json"):
            self.write(filename, (self.root / filename).read_text().replace('"1.1.7"', '"9.0.0"'))
            self.git("add", "-A")
            with self.assertRaises(cs.ChangesetError):
                cs.check_staged(self.root)

    def test_cli_add_status_version_and_errors(self):
        self.assertIn("next none", self.cli("status").stdout)
        self.assertIn("Created", self.cli("add", "--type", "fixed", "--bump", "patch", "CLI fix.").stdout)
        self.assertIn("next 1.1.8", self.cli("status").stdout)
        self.commit("CLI change")
        output = self.cli("version").stdout
        self.assertIn("Prepared 1.1.8", output)
        self.assertIn("No commit, tag or push", output)
        for args in (("add", "--empty", "--bump", "patch"), ("add", "--type", "fixed", "missing bump"), ("add",)):
            output = self.cli(*args, check=False)
            self.assertEqual(output.returncode, 1)
            self.assertNotIn("Traceback", output.stderr)

    def test_release_ready_blocks_private_unreleased_and_dirty_trees(self):
        with self.assertRaisesRegex(cs.ChangesetError, "private=false"):
            cs.release_ready(self.root)
        manifest = json.loads((self.root / "package.json").read_text())
        manifest.update(private=False, publishConfig={"access": "public", "registry": "https://registry.npmjs.org/"},
                        repository={"type": "git", "url": "https://example.invalid/fixture.git"})
        self.write_json("package.json", manifest)
        self.note()
        with self.assertRaisesRegex(cs.ChangesetError, "clean working tree"):
            cs.release_ready(self.root)
        self.commit("prepare publication metadata")
        with self.assertRaisesRegex(cs.ChangesetError, "pending changesets"):
            cs.release_ready(self.root)
        cs.release(self.root, TODAY)
        self.commit("version bump to v1.1.8")
        before = self.snapshot()
        self.assertIn("local release 1.1.8 is ready", cs.release_ready(self.root))
        self.assertEqual(self.snapshot(), before)
        self.write("extra.txt", "extra")
        with self.assertRaisesRegex(cs.ChangesetError, "clean working tree"):
            cs.release_ready(self.root)

    def test_release_ready_rejects_unreviewed_publication_metadata(self):
        manifest = json.loads((self.root / "package.json").read_text())
        manifest["private"] = False
        self.write_json("package.json", manifest)
        self.commit("public")
        with self.assertRaisesRegex(cs.ChangesetError, "publishConfig"):
            cs.release_ready(self.root)
        manifest["publishConfig"] = {"access": "public", "registry": "https://registry.npmjs.org/"}
        self.write_json("package.json", manifest)
        self.commit("registry")
        with self.assertRaisesRegex(cs.ChangesetError, "repository URL"):
            cs.release_ready(self.root)

    def test_symlink_release_files_fail_before_writes(self):
        self.note()
        target = self.write("alternate-changelog.md", cs.CHANGELOG_HEADER)
        (self.root / "CHANGELOG.md").unlink()
        (self.root / "CHANGELOG.md").symlink_to(target.name)
        self.commit("symlink")
        before = self.snapshot()
        with self.assertRaisesRegex(cs.ChangesetError, "symlinks"):
            cs.release(self.root, TODAY)
        self.assertEqual(self.snapshot(), before)

    def test_nonexecutable_notes_are_required(self):
        note = self.note()
        note.chmod(0o755)
        self.git("add", "-A")
        with self.assertRaisesRegex(cs.ChangesetError, "regular non-executable"):
            cs.check_staged(self.root)

    def test_real_package_plan_changes_only_three_version_fields(self):
        note = cs.Changeset("a.md", "fixed", "patch", "Test release.")
        version, updates = cs.release_updates(lambda p: (REPO / p).read_text(), [note], TODAY)
        for path in ("package.json", "package-lock.json"):
            before = json.loads((REPO / path).read_text())
            before["version"] = version
            if path == "package-lock.json":
                before["packages"][""]["version"] = version
            self.assertEqual(json.loads(updates[path]), before)


if __name__ == "__main__":
    unittest.main()

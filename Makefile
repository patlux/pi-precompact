PYTHON ?= python3

.PHONY: help verify hooks-install changeset changeset-status changeset-test version release-check

help:
	@printf "%s\n" "verify: all local/CI checks" "hooks-install: install the guarded changeset hook" "changeset: add a note or empty changeset" "changeset-status: preview pending release notes" "changeset-test: test the changeset tool" "version: prepare version/changelog on clean main; no commit/tag/push" "release-check: verify publication readiness; never publish"

verify:
	npm run check

hooks-install:
	$(PYTHON) scripts/changeset.py install-hook

changeset:
	$(PYTHON) scripts/changeset.py add

changeset-status:
	$(PYTHON) scripts/changeset.py status

changeset-test:
	$(PYTHON) -B scripts/test_changeset.py -v

version:
	$(PYTHON) scripts/changeset.py version

release-check:
	npm run release:check

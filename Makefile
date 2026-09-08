SHELL := /bin/bash

.PHONY: install-dev check test release-check

install-dev:
	cd runtime && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts

check:
	bash -n install.sh bin/* packaging/*.sh scripts/*.sh
	ruby -c Formula/open-computer-use.rb.in
	plutil -lint packaging/Info.plist packaging/CuaDriver.entitlements share/launchd/*.plist.in
	node --check runtime/server.mjs
	node --check runtime/browser-runtime.mjs
	node --check runtime/devtools-runtime.mjs
	node --check runtime/native-runtime.mjs
	node --check runtime/iterm-preview.mjs
	python3 scripts/validate-skill.py share/claude/skills/computer-use
	python3 scripts/check-repository.py

test:
	cd runtime && npm run smoke
	cd runtime && npm run test:devtools
	cd runtime && npm run test:resilience
	cd runtime && npm run test:preview
	cd runtime && npm run test:preview-viewer
	cd runtime && npm run test:native-runtime
	cd runtime && npm run test:teardown

release-check: check test
	scripts/check-release.sh

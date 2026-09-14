# vsc-opencode-gui build system
#
# VS Code extension with a native opencode webview app (Preact + esbuild).
# Recipes wrap the npm scripts (AGENTS.md: use npm run compile / watch, not
# ad-hoc tsc).
#
# Usage: make <target>

NAME      := $(shell node -p "require('./package.json').name")
VERSION   := $(shell node -p "require('./package.json').version")
PUBLISHER := $(shell node -p "require('./package.json').publisher")
VSIX      := $(NAME)-$(VERSION).vsix

.PHONY: build webview test test-unit test-ui watch package install uninstall publish clean help

# Installs devDependencies on first build (fresh clones have no node_modules).
node_modules/.bin/tsc:
	npm install

build: node_modules/.bin/tsc
	@echo "==> Compiling (tsc + webview templates)..."
	npm run compile

watch: node_modules/.bin/tsc
	@echo "==> Watching extension-host bundle (esbuild; webview needs npm run compile)..."
	npm run watch

webview: node_modules/.bin/tsc
	@echo "==> Compiling webview app only..."
	npm run compile:webview

# Phony must win over the test/ directory of the same name.
test: node_modules/.bin/tsc
	@echo "==> Testing (compile, unit suite, VS Code host suite)..."
	npm test

test-unit: node_modules/.bin/tsc
	@echo "==> Unit suite only..."
	npm run test:unit

test-ui: build
	@echo "==> Playwright UI suite (real server via ui-rig)..."
	npm run test:ui

package: build
	@echo "==> Packaging $(VSIX)..."
	npx --yes @vscode/vsce package
	@echo "    Built: $(VSIX)"

install: package
	@echo "==> Installing $(VSIX) into VS Code..."
	code --install-extension $(VSIX)
	@echo "    Installed $(PUBLISHER).$(NAME) $(VERSION) — reload windows to activate."

uninstall:
	code --uninstall-extension $(PUBLISHER).$(NAME)

publish:
	@echo "==> Compiling, then publishing to VS Code Marketplace + Open VSX..."
	npm run publish

clean:
	rm -rf out *.vsix
	@echo "Cleaned."

help:
	@echo ""
	@echo "  vsc-opencode-gui build"
	@echo "  Usage: make <target>"
	@echo ""
	@echo "    build      Compile TypeScript + copy webview templates (out/)"
	@echo "    webview    Compile the webview app only"
	@echo "    test       Compile, run unit + VS Code host suites (npm test)"
	@echo "    test-unit  Unit suite only"
	@echo "    test-ui    Playwright UI suite (builds first)"
	@echo "    watch      Recompile on change"
	@echo "    package    Build and package $(VSIX)"
	@echo "    install    Package and install into VS Code (reload windows after)"
	@echo "    uninstall  Remove $(PUBLISHER).$(NAME) from VS Code"
	@echo "    publish    Compile and publish to Marketplace + Open VSX"
	@echo "    clean      Remove out/ and *.vsix"
	@echo ""
	@echo "  Debug: open this folder in VS Code and press F5 (Extension"
	@echo "  Development Host). See AGENTS.md for the verification bar."
	@echo ""

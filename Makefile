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

.PHONY: build test watch package install uninstall clean help

# Installs devDependencies on first build (fresh clones have no node_modules).
node_modules/.bin/tsc:
	npm install

build: node_modules/.bin/tsc
	@echo "==> Compiling (tsc + webview templates)..."
	npm run compile

# Phony must win over the test/ directory of the same name.
test: node_modules/.bin/tsc
	@echo "==> Testing (compile, unit suite, VS Code host suite)..."
	npm test

watch: node_modules/.bin/tsc
	@echo "==> Watching extension-host bundle (esbuild; webview needs npm run compile)..."
	npm run watch

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

clean:
	rm -rf out *.vsix
	@echo "Cleaned."

help:
	@echo ""
	@echo "  vsc-opencode-gui build"
	@echo "  Usage: make <target>"
	@echo ""
	@echo "    build      Compile TypeScript + copy webview templates (out/)"
	@echo "    test       Compile, run unit + VS Code host suites (npm test)"
	@echo "    watch      Recompile on change"
	@echo "    package    Build and package $(VSIX)"
	@echo "    install    Package and install into VS Code (reload windows after)"
	@echo "    uninstall  Remove $(PUBLISHER).$(NAME) from VS Code"
	@echo "    clean      Remove out/ and *.vsix"
	@echo ""
	@echo "  Debug: open this folder in VS Code and press F5 (Extension"
	@echo "  Development Host). See AGENTS.md for the verification bar."
	@echo ""

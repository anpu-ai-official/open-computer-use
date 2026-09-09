class OpenComputerUse < Formula
  desc "Parallel background browser and native computer use for agy CLI and Claude Code"
  homepage "https://github.com/anpu-ai-official/open-computer-use"
  url "https://github.com/anpu-ai-official/open-computer-use/releases/download/v0.1.0/open-computer-use-0.1.0-darwin-arm64.tar.gz"
  sha256 "b66a99f01ac374d42efd8e82d8a20bb2d6adeb292730cbe1be5cc32e5494512a"
  version "0.1.0"
  license "MIT"

  depends_on macos: :ventura

  on_intel do
    odie "Open Computer Use currently supports only Apple-silicon Macs"
  end

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/open-computer-use"
    bin.install_symlink libexec/"bin/open-computer-use" => "ocu"
    bin.install_symlink libexec/"bin/open-computer-use" => "claude-computer-use"
    bin.install_symlink libexec/"bin/claude-cua-preview"
    bin.install_symlink libexec/"bin/claude-cua-preview" => "ocu-preview"
  end

  def post_install
    system bin/"open-computer-use", "setup", "--non-interactive", "--skip-permissions"
  end

  def caveats
    <<~EOS
      macOS does not allow sudo or Homebrew to grant Accessibility and Screen Recording.
      Complete Apple's one-time approval with:

        open-computer-use permissions

      Then verify the entire installation with:

        open-computer-use doctor
    EOS
  end

  test do
    system bin/"open-computer-use", "doctor", "--bundle-only"
  end
end

# NOTE: sha256 will be updated once the first desktop-v* release is published.
# Submit to homebrew/homebrew-cask after first release tag is cut.
cask "gitnexus-desktop" do
  version "0.1.0"
  sha256 :no_check

  url "https://github.com/abhigyanpatwari/GitNexus/releases/download/desktop-v#{version}/GitNexus-Desktop-#{version}.dmg"
  name "GitNexus Desktop"
  desc "Cross-platform desktop app for GitNexus code intelligence"
  homepage "https://github.com/abhigyanpatwari/GitNexus"

  app "GitNexus Desktop.app"
end
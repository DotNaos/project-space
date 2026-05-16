cask "project-space" do
  version "0.3.0"
  sha256 "REPLACE_WITH_RELEASE_SHA256"

  url "https://github.com/DotNaos/project-space/releases/download/v#{version}/project-space_macos_app.zip"
  name "Project Space"
  desc "Native macOS shell for Project Space"
  homepage "https://github.com/DotNaos/project-space"

  app "Project Space.app"
end

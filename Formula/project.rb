# frozen_string_literal: true

# Installs the Project CLI from the Project Space source tree.
class Project < Formula
  desc "Template-aware Project CLI"
  homepage "https://github.com/DotNaos/project-space"
  head "https://github.com/DotNaos/project-space.git", using: :git, branch: "main"

  depends_on "go" => :build

  def install
    ldflags = "-X main.projectMachineClientVersion=#{version}"
    system "go", "build", "-trimpath", "-ldflags=#{ldflags}", "-o", bin/"project", "./cmd/project"
    generate_completions_from_executable bin/"project", "completion", shells: [:zsh]
  end

  test do
    system bin/"project", "--help"
    system bin/"project", "init", "--help"
  end
end

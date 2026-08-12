# frozen_string_literal: true

# Installs the Project CLI from the Project Space source tree.
class Project < Formula
  desc "Template-aware Project CLI"
  homepage "https://github.com/DotNaos/project-space"
  head "https://github.com/DotNaos/project-space.git", using: :git, branch: "main"

  depends_on "bun" => :build
  depends_on "go" => :build

  def install
    ldflags = "-X main.projectMachineClientVersion=#{version}"
    system "bun", "install", "--frozen-lockfile"
    system "bun", "run", "build:codex-host:native"
    system "go", "build", "-trimpath", "-ldflags=#{ldflags}", "-o", bin/"project", "./cmd/project"
    bin.install "dist/project-codex-host"
    generate_completions_from_executable bin/"project", "completion", shells: [:zsh]
  end

  test do
    assert_predicate bin/"project-codex-host", :executable?
    system bin/"project-codex-host", "--help"
    system bin/"project", "--help"
    system bin/"project", "init", "--help"
  end
end

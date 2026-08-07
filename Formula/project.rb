# frozen_string_literal: true

require "json"

# Installs the Project CLI from the Project Space source tree.
class Project < Formula
  desc "Template-aware Project CLI"
  homepage "https://github.com/DotNaos/project-space"
  head "https://github.com/DotNaos/project-space.git", using: :git, branch: "main"

  depends_on "bun" => :build
  depends_on "go" => :build

  def install
    project_version = JSON.parse((buildpath/"package.json").read).fetch("version")
    ldflags = "-X main.projectMachineClientVersion=#{project_version}"
    system "bun", "install", "--frozen-lockfile"
    system "bun", "run", "build:connector:native"
    system "go", "build", "-trimpath", "-ldflags=#{ldflags}", "-o", bin/"project", "./cmd/project"
    bin.install "dist/project-space-connector"
    generate_completions_from_executable bin/"project", "completion", shells: [:zsh]
  end

  test do
    assert_predicate bin/"project-space-connector", :executable?
    system bin/"project-space-connector", "--help"
    system bin/"project", "--help"
    system bin/"project", "init", "--help"
  end
end

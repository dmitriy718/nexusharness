import { describe, expect, it } from "vitest";
import { FirecrackerLauncherFoundation, buildFirecrackerConfig, buildJailerArgs, type FirecrackerProfileInput } from "../server/execution/firecrackerProvider";

describe("Firecracker launcher foundation", () => {
  it("builds a networkless bounded microVM configuration", () => {
    const config = buildFirecrackerConfig(profile());
    expect(config.network_interfaces).toEqual([]);
    expect(config["machine-config"]).toEqual({ vcpu_count: 2, mem_size_mib: 1024, smt: false });
    expect(config["boot-source"].boot_args).toContain("nomodules ro");
    expect(config.drives[0]).toMatchObject({ drive_id: "rootfs", is_root_device: true, path_on_host: "/rootfs.ext4" });
  });

  it("builds jailer arguments with privilege drop, cgroup, namespace, and resource limits", () => {
    const args = buildJailerArgs(profile());
    expect(args).toEqual(expect.arrayContaining(["--exec-file", "/usr/bin/firecracker", "--chroot-base-dir", "/srv/jailer"]));
    expect(args).toEqual(expect.arrayContaining(["--uid", "1234", "--gid", "1234", "--cgroup-version", "2", "--new-pid-ns", "--resource-limit", "no-file=512", "--no-api", "--config-file", "/config.json"]));
    expect(args).not.toContain("--netns");
    expect(args).not.toContain("--daemonize");
  });

  it("remains unverified and unavailable on non-Linux hosts", async () => {
    const launcher = new FirecrackerLauncherFoundation(profile(), "win32");
    expect(launcher.securityBoundary).toBe(false);
    expect(await launcher.probe()).toMatchObject({ available: false, platformSupported: false });
    expect(launcher.launchCommand()).toEqual({ command: "/usr/bin/jailer", args: launcher.jailerArgs() });
  });

  it.each([
    { id: "bad_id" }, { uid: 0 }, { gid: 0 }, { firecrackerPath: "relative/firecracker" },
    { configPathInJail: "config.json" }, { configPathInJail: "/../config.json" }, { kernelImagePath: "/var/lib/nexus/../vmlinux" },
    { vcpuCount: 0 }, { memoryMib: 64 }, { parentCgroup: "../escape" }, { rootfsPath: "/var/lib/nexus/vmlinux" },
    { kernelImagePath: "/var/lib/nexus/firecracker" }, { configPathInJail: "/rootfs.ext4" }
  ])("rejects unsafe or unbounded profile %#", (override) => {
    expect(() => new FirecrackerLauncherFoundation({ ...profile(), ...override })).toThrow();
  });
});

function profile(): FirecrackerProfileInput {
  return {
    id: "nexus-cell-1", firecrackerPath: "/usr/bin/firecracker", jailerPath: "/usr/bin/jailer",
    chrootBaseDir: "/srv/jailer", kernelImagePath: "/var/lib/nexus/vmlinux", rootfsPath: "/var/lib/nexus/rootfs.ext4",
    configPathInJail: "/config.json", uid: 1234, gid: 1234, vcpuCount: 2, memoryMib: 1024,
    maxOpenFiles: 512, maxFileBytes: 2 * 1024 * 1024 * 1024, cgroupVersion: 2, parentCgroup: "nexusharness/cells"
  };
}

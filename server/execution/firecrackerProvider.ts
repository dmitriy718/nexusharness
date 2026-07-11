import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

export interface FirecrackerProbe {
  available: boolean;
  platformSupported: boolean;
  kvmAvailable: boolean;
  firecrackerAvailable: boolean;
  jailerAvailable: boolean;
  reason: string;
}

export interface FirecrackerProfileInput {
  id: string;
  firecrackerPath: string;
  jailerPath: string;
  chrootBaseDir: string;
  kernelImagePath: string;
  rootfsPath: string;
  configPathInJail: string;
  uid: number;
  gid: number;
  vcpuCount?: number;
  memoryMib?: number;
  maxFileBytes?: number;
  maxOpenFiles?: number;
  cgroupVersion?: 1 | 2;
  parentCgroup?: string;
}

export class FirecrackerLauncherFoundation {
  readonly securityBoundary = false;
  readonly boundaryDescription = "Firecracker+jailer profile follows the production isolation baseline, but no Linux/KVM real-host checkpoint has verified this adapter.";

  constructor(private readonly input: FirecrackerProfileInput, private readonly platform: NodeJS.Platform = process.platform) {
    validate(input);
  }

  async probe(): Promise<FirecrackerProbe> {
    const platformSupported = this.platform === "linux";
    const [kvmAvailable, firecrackerAvailable, jailerAvailable] = await Promise.all([
      platformSupported ? usableKvm() : Promise.resolve(false),
      executable(this.input.firecrackerPath),
      executable(this.input.jailerPath)
    ]);
    const available = platformSupported && kvmAvailable && firecrackerAvailable && jailerAvailable;
    return {
      available, platformSupported, kvmAvailable, firecrackerAvailable, jailerAvailable,
      reason: available
        ? "Linux KVM, Firecracker, and jailer inputs are present; real-host isolation verification remains required."
        : !platformSupported ? "Firecracker requires a Linux host." : !kvmAvailable ? "/dev/kvm is unavailable." : !firecrackerAvailable ? "Firecracker executable is unavailable." : "Matching jailer executable is unavailable."
    };
  }

  config() {
    return buildFirecrackerConfig(this.input);
  }

  jailerArgs() {
    return buildJailerArgs(this.input);
  }

  launchCommand() {
    return { command: this.input.jailerPath, args: buildJailerArgs(this.input) };
  }
}

export function buildFirecrackerConfig(input: FirecrackerProfileInput) {
  validate(input);
  return {
    "boot-source": {
      kernel_image_path: jailedPath(input.kernelImagePath),
      boot_args: "console=ttyS0 reboot=k panic=1 pci=off nomodules ro"
    },
    drives: [{ drive_id: "rootfs", path_on_host: jailedPath(input.rootfsPath), is_root_device: true, is_read_only: false }],
    "machine-config": { vcpu_count: input.vcpuCount ?? 1, mem_size_mib: input.memoryMib ?? 512, smt: false },
    network_interfaces: []
  };
}

export function buildJailerArgs(input: FirecrackerProfileInput) {
  validate(input);
  return [
    "--id", input.id,
    "--exec-file", input.firecrackerPath,
    "--uid", String(input.uid),
    "--gid", String(input.gid),
    "--chroot-base-dir", input.chrootBaseDir,
    "--cgroup-version", String(input.cgroupVersion ?? 2),
    "--parent-cgroup", input.parentCgroup ?? "nexusharness",
    "--resource-limit", `no-file=${input.maxOpenFiles ?? 1024}`,
    "--resource-limit", `fsize=${input.maxFileBytes ?? 1024 * 1024 * 1024}`,
    "--new-pid-ns",
    "--",
    "--no-api",
    "--config-file", input.configPathInJail
  ];
}

function validate(input: FirecrackerProfileInput) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(input.id)) throw new Error("Firecracker id must contain 1-64 alphanumeric or hyphen characters.");
  for (const [label, value] of [["firecrackerPath", input.firecrackerPath], ["jailerPath", input.jailerPath], ["chrootBaseDir", input.chrootBaseDir], ["kernelImagePath", input.kernelImagePath], ["rootfsPath", input.rootfsPath]] as const) {
    if (!safePosixAbsolutePath(value)) throw new Error(`Firecracker ${label} must be a normalized absolute Linux path without traversal.`);
  }
  if (!safePosixAbsolutePath(input.configPathInJail)) throw new Error("Firecracker configPathInJail must be a normalized absolute jailed path without traversal.");
  const stagedPaths = [jailedPath(input.kernelImagePath), jailedPath(input.rootfsPath), `/${path.posix.basename(input.firecrackerPath)}`, input.configPathInJail];
  if (new Set(stagedPaths).size !== stagedPaths.length) throw new Error("Firecracker staged kernel, rootfs, executable, and configuration paths must not collide inside the jail.");
  if (!Number.isSafeInteger(input.uid) || input.uid <= 0 || !Number.isSafeInteger(input.gid) || input.gid <= 0) throw new Error("Firecracker requires dedicated non-root uid and gid values.");
  bounded(input.vcpuCount ?? 1, 1, 32, "vcpuCount");
  bounded(input.memoryMib ?? 512, 128, 131072, "memoryMib");
  bounded(input.maxOpenFiles ?? 1024, 32, 65535, "maxOpenFiles");
  bounded(input.maxFileBytes ?? 1024 * 1024 * 1024, 1024 * 1024, Number.MAX_SAFE_INTEGER, "maxFileBytes");
  if (!/^[A-Za-z0-9][A-Za-z0-9_/-]{0,199}$/.test(input.parentCgroup ?? "nexusharness")) throw new Error("Firecracker parentCgroup must be a safe relative cgroup path.");
}

function bounded(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Firecracker ${label} must be an integer from ${minimum} through ${maximum}.`);
}

function safePosixAbsolutePath(value: string) {
  return value.length > 1 && !value.includes("\0") && path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.split("/").some((part) => part === "." || part === "..");
}

function jailedPath(hostPath: string) { return `/${path.posix.basename(hostPath)}`; }
async function usableKvm() { try { const details = await stat("/dev/kvm"); await access("/dev/kvm", constants.R_OK | constants.W_OK); return details.isCharacterDevice(); } catch { return false; } }
async function executable(target: string) { try { const details = await stat(target); return details.isFile() && Boolean(details.mode & 0o111); } catch { return false; } }

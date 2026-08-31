import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export const WINDOWS_INSTALLER_SIGNER_ALLOWLIST = ["Anysphere, Inc.", "Anysphere"] as const;
export const POWERSHELL_TIMEOUT_MS = 30_000;
export class SandInstallerSignatureError extends Error {}
const execFileAsync = promisify(execFile);
async function runPowershellDefault(args: readonly string[]): Promise<{ stdout: string }> { return await execFileAsync("powershell.exe", [...args], { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true }); }
function spawnDetachedDefault(command: string, args: readonly string[], onError?: (error: Error) => void): void { const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true }); child.on("error", (error) => onError?.(error)); child.unref(); }
export class SandWindowsInstaller {
  constructor(private readonly options: { readonly quit: () => void; readonly log?: (message: string) => void; readonly signerAllowlist?: readonly string[]; readonly runPowershell?: (args: readonly string[]) => Promise<{ stdout: string }>; readonly spawnDetached?: (command: string, args: readonly string[], onError?: (error: Error) => void) => void }) {}
  async verifySignature(installerPath: string): Promise<void> {
    const escapedPath = installerPath.replace(/'/g, "''");
    const script = ["$ErrorActionPreference = 'Stop'", `$sig = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`, "$cn = if ($sig.SignerCertificate) { $sig.SignerCertificate.GetNameInfo('SimpleName', $false) } else { '' }", "[pscustomobject]@{ status = $sig.Status.ToString(); signerCommonName = $cn } | ConvertTo-Json -Compress"].join("; ");
    const { stdout } = await (this.options.runPowershell ?? runPowershellDefault)(["-NoProfile", "-NonInteractive", "-Command", script]);
    let probe: unknown; try { probe = JSON.parse(stdout.trim()); } catch { throw new SandInstallerSignatureError("unreadable signature probe output"); }
    if (typeof probe !== "object" || probe === null || typeof (probe as any).status !== "string" || typeof (probe as any).signerCommonName !== "string") throw new SandInstallerSignatureError("unreadable signature probe output");
    if ((probe as any).status !== "Valid") throw new SandInstallerSignatureError(`signature status ${(probe as any).status}`);
    if (!(this.options.signerAllowlist ?? WINDOWS_INSTALLER_SIGNER_ALLOWLIST).includes((probe as any).signerCommonName)) throw new SandInstallerSignatureError(`unexpected signer "${(probe as any).signerCommonName}"`);
  }
  installOnQuit(installerPath: string, options: { readonly forceRun: boolean; readonly onSpawnError?: (error: unknown) => void }): void { this.runInstaller(installerPath, options.forceRun ? ["--updated", "/S", "--force-run"] : ["--updated", "/S"], options.onSpawnError); }
  quit(): void { this.options.quit(); }
  private runInstaller(installerPath: string, args: readonly string[], onSpawnError?: (error: unknown) => void): void { this.options.log?.(`Running installer: ${installerPath} ${args.join(" ")}`); try { (this.options.spawnDetached ?? spawnDetachedDefault)(installerPath, args, onSpawnError); } catch (error) { this.options.log?.(`Installer spawn failed: ${error instanceof Error ? error.message : String(error)}`); onSpawnError?.(error); } }
}

export const NETWORK_COMMANDS = ["curl", "wget", "ping", "nslookup", "dig", "host", "traceroute", "telnet", "nc", "netcat", "ifconfig", "ip", "iwconfig", "iwlist", "arp", "route", "iptables", "ufw", "firewall-cmd", "ss", "netstat", "lsof", "tcpdump", "wireshark", "tshark", "nmap", "masscan", "zmap", "ssh", "scp", "rsync", "git", "pip", "apt", "yum", "brew", "docker", "kubectl", "aws", "gcloud", "az", "terraform", "ansible", "mvn", "gradle", "composer", "cargo", "go", "nuget", "gem", "bundle", "npm install", "yarn install", "pnpm install", "pip install", "apt install", "yum install", "brew install", "docker pull", "docker push", "git clone", "git pull", "git push", "git fetch", "ssh", "scp", "rsync"] as const;
export function isNetworkCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return NETWORK_COMMANDS.some((networkCommand) => normalized.startsWith(networkCommand.toLowerCase()));
}
export function analyzeFailure(exitCode: number | null | undefined, stderr: string | undefined, command?: string): "network" | "sandbox" | "unknown" {
  const output = stderr || "";
  if (command && isNetworkCommand(command)) return "network";
  if (/connection refused|network is unreachable|no route to host|timeout|could not resolve host|name or service not known|temporary failure in name resolution|connection timed out|connection reset by peer|host unreachable/i.test(output)) return "network";
  return (exitCode ?? -1) !== 0 && /operation not permitted|EPERM|EACCES/i.test(output) ? "sandbox" : "unknown";
}

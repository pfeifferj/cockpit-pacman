#!/usr/bin/env python3
import base64
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import urllib.parse
import zipfile


def inspect(data, forms):
    if any(value in data for value in forms):
        raise RuntimeError("Authentication credential found in test output")
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for name in archive.namelist():
                inspect(archive.read(name), forms)
    for encoded in re.findall(rb"data:application/zip;base64,([A-Za-z0-9+/=]+)", data):
        inspect(base64.b64decode(encoded), forms)


def main():
    root = Path(__file__).resolve().parent.parent
    canary = "rejected-" + secrets.token_hex(24)
    env = os.environ.copy()
    env.update(COCKPIT_PASSWORD=canary, COCKPIT_USER=env.get("COCKPIT_USER", "dev"))
    forms = [value.encode() for value in (
        canary, json.dumps(canary)[1:-1], urllib.parse.quote(canary),
        base64.b64encode(canary.encode()).decode(),
        base64.b64encode(f"{env['COCKPIT_USER']}:{canary}".encode()).decode(),
        base64.b64encode(f"{env['COCKPIT_USER']}:{canary}\0".encode()).decode(),
    )]
    with tempfile.TemporaryDirectory(prefix="cockpit-auth-artifacts-") as directory:
        work = Path(directory)
        sentinel = "Rejected credential reached Cockpit authentication"
        (work / "auth-canary.spec.ts").write_text(
            f"import {{ test, authenticate }} from {json.dumps(str(root / 'e2e/auth'))};\n"
            "test('reject credential without retaining it', async ({ page }) => {\n"
            "  const credentials = process.env.COCKPIT_USER + ':' + process.env.COCKPIT_PASSWORD;\n"
            "  const rejected = page.waitForResponse(async response => {\n"
            "    if (new URL(response.url()).pathname !== '/cockpit/login' || response.status() !== 401) return false;\n"
            "    const header = await response.request().headerValue('authorization');\n"
            "    return header?.startsWith('Basic ') &&\n"
            "      Buffer.from(header.slice(6), 'base64').toString().split('\\0')[0] === credentials;\n"
            "  }, { timeout: 10000 });\n"
            "  const failed = authenticate(page, false).then(() => false, () => true);\n"
            "  await rejected;\n"
            "  await page.close();\n"
            "  if (!await failed) throw new Error('Rejected authentication unexpectedly succeeded');\n"
            f"  throw new Error({json.dumps(sentinel)});\n"
            "});\n"
        )
        config = work / "playwright.config.ts"
        config.write_text(
            f"import config from {json.dumps(str(root / 'playwright.config.ts'))};\n"
            "export default { ...config, "
            f"testDir: {json.dumps(str(work))}, "
            f"outputDir: {json.dumps(str(work / 'results'))}, "
            "retries: 1, timeout: 15000, "
            "projects: [{ name: 'canary', testMatch: /auth-canary\\.spec\\.ts/ }], "
            f"reporter: [['html', {{ outputFolder: {json.dumps(str(work / 'report'))}, open: 'never' }}], "
            f"['json', {{ outputFile: {json.dumps(str(work / 'report.json'))} }}]] }};\n"
        )
        for extra in ([], ["--trace", "on"]):
            result = subprocess.run(
                [str(root / "node_modules/.bin/playwright"), "test", "--config", str(config), *extra],
                cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            inspect(result.stdout, forms)
            for path in work.rglob("*"):
                if path.is_file():
                    inspect(path.read_bytes(), forms)
            if result.returncode != 1:
                raise RuntimeError("The rejected-credential test did not fail as expected")
            report = json.loads((work / "report.json").read_text())
            results = report["suites"][0]["specs"][0]["tests"][0]["results"]
            if len(results) != 2 or any(entry["status"] == "passed" for entry in results):
                raise RuntimeError("The rejected-credential test did not execute both attempts")
            expected = "requires trace" if extra else sentinel
            if not all(expected in str(entry.get("errors")) for entry in results):
                details = "\n".join(str(entry.get("errors")) + str(entry.get("stdout")) for entry in results)
                for value in forms:
                    details = details.replace(value.decode(), "[credential]")
                raise RuntimeError("The credential test did not reach its expected failure: " + details)
    print("Authentication failure and retry artifacts contain no credential canary; trace override rejected")


if __name__ == "__main__":
    main()

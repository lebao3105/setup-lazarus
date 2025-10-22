import * as core from "@actions/core";
import * as tc from "@actions/tool-cache";
import { exec } from "@actions/exec/lib/exec";
import * as os from "os";
import * as path from "path";
import { ok } from "assert";
import * as fs from "fs";

import { Cache } from "./cache";

const StableVersion = "4.2";

function findFPCVersion(ver: string): string {
  if (ver.startsWith("2.0.1")) { // 2.0.10 and 2.0.12
    return "3.2.0";
  }

  if (ver.startsWith("2.0.") || ver.startsWith("1.8")) {
    return "3.0.4";
  }

  if (ver === "1.6.4") return "3.0.2";

  if (ver.startsWith("1.6")) return "3.0.0";

  if (ver === "1.2.0" || ver.startsWith("1.0")) return "2.6.2";

  if (ver.startsWith("1.4") || ver.startsWith("1.2"))
    return "2.6.4";

  return "3.2.2";
}

function createLazarusFileName(ver: string): object | string {
  const p = os.platform();
  const fpcver = findFPCVersion(ver);

  if (p.startsWith("win")) {
    return `lazarus-${ver}-fpc-${fpcver}-${os.arch() == "x64" ? "win64" : "win32"}.exe`;
  }

  var fpcverSuffix: string = "";

  if (p === "darwin") {
    if (fpcver === "3.2.0")
      fpcverSuffix = "2";
    else if (fpcver === "3.2.2")
      fpcverSuffix = "20210709";
    // ignore older versions of FPC and Lazarus
  }
  else {
    switch (fpcver) {
      case "3.2.2":
        fpcverSuffix = "210709";
        break;
      case "3.2.0":
        fpcverSuffix = "1";
        break;
      case "3.0.4":
        fpcverSuffix = "2";
        break;
      case "3.0.2":
        fpcverSuffix = "170225";
        break;
      case "3.0.0":
        fpcverSuffix = "151205";
        break;
      case "2.6.4":
        fpcverSuffix =
          ver.startsWith("1.2.") && ver !== "1.2.0" ? "140420" : "150228";
        break;
      case "2.6.2":
        fpcverSuffix = "0";
        break;
    }
  }

  if (p === "darwin") {
    return ver !== "2.0.8" ? {
      laz: `Lazarus-${ver}-macosx-${p}.pkg`,
      fpc: `fpc-${fpcver}.intel${fpcver.startsWith("2.0") ? "" : "arm64"}-macosx.dmg`,
      fpcsrc: `fpc-src-${fpcver}-${fpcverSuffix}-laz.${ver.startsWith("2.0") ? "pkg" : "dmg"}`
    } : {
      laz: "LazarusIDE-2.0.8-macos-x86_64.pkg",
      fpc: "fpc-3.0.4-macos-x86_64-laz-2.dmg",
      fpcsrc: "fpc-src-3.0.4-laz.pkg"
    };
  } else {
    return {
      laz: `lazarus-project_${ver}-0_amd64.deb`,
      fpc: `fpc${!ver.startsWith("1.") ? "_" : "-laz-"}${fpcver}-${fpcver === "3.0.4" ? "1" : fpcverSuffix}_amd64.deb`,
      fpcsrc: `fpc-src_${fpcver}-${fpcverSuffix}_amd64.deb`
    };
  }
}

export class Lazarus {
  private _Platform: string = os.platform();
  private _Arch: string = os.arch();
  private _LazarusVersion: string = "";
  private _Cache: Cache;

  constructor(LazarusVersion: string, WithCache: boolean) {
    this._LazarusVersion = LazarusVersion;
    this._Cache = new Cache(WithCache);
    this._Cache.key =
      this._LazarusVersion + "-" + this._Arch + "-" + this._Platform;
  }

  async installLazarus(): Promise<void> {
    core.info(
      `installLazarus -- Installing Lazarus ${this._LazarusVersion} on platform: "${this._Platform}"; arch: "${this._Arch}"`
    );
    switch (this._LazarusVersion) {
      // Special case named version that installs the repository pakages on Ubuntu
      // but installs stable version under Windows
      case "dist":
        switch (this._Platform) {
          case "linux":
            // Perform a repository update
            await exec("sudo apt update");
            // Install Lazarus from the Ubuntu repository
            await exec("sudo apt install -y lazarus --no-install-recommends");
            break;
          case "win32":
            this._LazarusVersion = StableVersion;
            this._Cache.key =
              this._LazarusVersion + "-" + this._Arch + "-" + this._Platform;
            await this._downloadLazarus();
            break;
          default:
            throw new Error(
              `getLazarus - Platform not supported: ${this._Platform}`
            );
        }
        break;
      // Special case named version that installs the latest stable version
      case "stable":
        this._LazarusVersion = StableVersion;
        this._Cache.key =
          this._LazarusVersion + "-" + this._Arch + "-" + this._Platform;
        await this._downloadLazarus();
        break;
      default:
        if (this._Platform == "darwin") {
          if ((this._LazarusVersion.startsWith("2.0") &&
            this._LazarusVersion !== "2.0.8") ||
            this._LazarusVersion.startsWith("1.")) {
            throw new Error(
              "GitHub runners do not support Lazarus below 2.0.8 on macos"
            );
          }
        }
        await this._downloadLazarus();
        break;
    }
  }

  private async _downloadLazarus(): Promise<void> {
    // Try to restore installers from cache
    let cacheRestored = false;
    if (this._Platform != "win32") {
      cacheRestored = await this._Cache.restore();
    }

    switch (this._Platform) {
      case "win32":
        // Get the URL of the file to download
        let downloadURL: string = this._getPackageURL("laz");
        core.info(`_downloadLazarus - Downloading ${downloadURL}`);

        let downloadPath_WIN: string;

          if (cacheRestored) {
            // Use cached version
            downloadPath_WIN = path.join(
              this._getTempDirectory(),
              `lazarus-${this._LazarusVersion}.exe`
            );
            core.info(
              `_downloadLazarus - Using cache restored into ${downloadPath_WIN}`
            );
          } else {
            // Perform the download
            downloadPath_WIN = await tc.downloadTool(
              downloadURL,
              path.join(
                this._getTempDirectory(),
                `lazarus-${this._LazarusVersion}.exe`
              )
            );
            core.info(`_downloadLazarus - Downloaded into ${downloadPath_WIN}`);
          }

          // Run the installer
          let lazarusDir: string = path.join(
            this._getTempDirectory(),
            "lazarus"
          );
          await exec(`${downloadPath_WIN} /VERYSILENT /SP- /DIR=${lazarusDir}`);

          // Add this path to the runner's global path
          core.addPath(lazarusDir);
          core.info(`_downloadLazarus - Adding '${lazarusDir}' to PATH`);

          // Add the path to fpc.exe to the runner's global path
          // TODO: This is very sketchy and may break in the future. Needs better implementation!
          let parts = (createLazarusFileName(this._LazarusVersion) as string).split("-");
          let fpc_version = parts[3];
          let fpcDir = path.join(
            lazarusDir,
            "fpc",
            fpc_version,
            "bin",
            `x86_64-${os.arch() == "x64" ? "win64" : "win32"}`
          );
          core.addPath(fpcDir);
          core.info(`_downloadLazarus - Added '${fpcDir}' to PATH`);
          
          // fpmake will check for units in
          // %FPCSRC%\units\<target>\<package>
          // Confirmed by a fresh installation of Lazarus.
          // The same goes to other OSes.
          core.exportVariable('FPCDIR', path.join(
            lazarusDir, "fpc", fpc_version));
        break;
      case "linux":
        // Perform a repository update
        await exec("sudo apt update");

        let downloadPath_LIN: string;

        // Get the URL for Free Pascal Source
        let downloadFPCSRCURL: string = this._getPackageURL("fpcsrc");
        core.info(`_downloadLazarus - Downloading ${downloadFPCSRCURL}`);
          if (cacheRestored) {
            // Use cached version
            downloadPath_LIN = path.join(
              this._getTempDirectory(),
              "fpcsrc.deb"
            );
            core.info(
              `_downloadLazarus - Using cache restored into ${downloadPath_LIN}`
            );
          } else {
            // Perform the download
            downloadPath_LIN = await tc.downloadTool(
              downloadFPCSRCURL,
              path.join(this._getTempDirectory(), "fpcsrc.deb")
            );
            core.info(`_downloadLazarus - Downloaded into ${downloadPath_LIN}`);
          }
          // Install the package
          await exec(`sudo apt install -y ${downloadPath_LIN}`);

        // Get the URL for Free Pascal's compiler
        let downloadFPCURL: string = this._getPackageURL("fpc");
        core.info(`_downloadLazarus - Downloading ${downloadFPCURL}`);
        try {
          if (cacheRestored) {
            // Use cached version
            downloadPath_LIN = path.join(this._getTempDirectory(), "fpc.deb");
            core.info(
              `_downloadLazarus - Using cache restored into ${downloadPath_LIN}`
            );
          } else {
            // Perform the download
            downloadPath_LIN = await tc.downloadTool(
              downloadFPCURL,
              path.join(this._getTempDirectory(), "fpc.deb")
            );
            core.info(`_downloadLazarus - Downloaded into ${downloadPath_LIN}`);
          }
          // Install the package
          await exec(`sudo apt install -y ${downloadPath_LIN}`);
        } catch (error) {
          throw error as Error;
        }

        // Get the URL for the Lazarus IDE
        let downloadLazURL: string = this._getPackageURL("laz");
        core.info(`_downloadLazarus - Downloading ${downloadLazURL}`);
        try {
          if (cacheRestored) {
            // Use cached version
            downloadPath_LIN = path.join(
              this._getTempDirectory(),
              "lazarus.deb"
            );
            core.info(
              `_downloadLazarus - Using cache restored into ${downloadPath_LIN}`
            );
          } else {
            // Perform the download
            downloadPath_LIN = await tc.downloadTool(
              downloadLazURL,
              path.join(this._getTempDirectory(), "lazarus.deb")
            );
            core.info(`_downloadLazarus - Downloaded into ${downloadPath_LIN}`);
          }
          // Install the package
          await exec(`sudo apt install -y ${downloadPath_LIN}`);
        } catch (error) {
          throw error as Error;
        }

        break;
      case "darwin":
        let downloadPath_DAR: string;

        // Get the URL for Free Pascal Source
        let downloadFPCSRCURLDAR: string = this._getPackageURL("fpcsrc");
        core.info(`_downloadLazarus - Downloading ${downloadFPCSRCURLDAR}`);
        try {
          // Decide what the local download filename should be
          var downloadName = downloadFPCSRCURLDAR.endsWith(".dmg")
            ? "fpcsrc.dmg"
            : "fpcsrc.pkg";

          if (cacheRestored) {
            // Use cached version
            downloadPath_DAR = path.join(
              this._getTempDirectory(),
              downloadName
            );
            core.info(
              `_downloadLazarus - Using cache restored into ${downloadPath_DAR}`
            );
          } else {
            // Perform the download
            downloadPath_DAR = await tc.downloadTool(
              downloadFPCSRCURLDAR,
              path.join(this._getTempDirectory(), downloadName)
            );
            core.info(`_downloadLazarus - Downloaded into ${downloadPath_DAR}`);
          }

          // Download could be a pkg or dmg, handle either case
          if (downloadName == "fpcsrc.dmg") {
            // Mount DMG and intall package
            await exec(`sudo hdiutil attach ${downloadPath_DAR}`);

            // There MUST be a better way to do this
            var fpcsrc = fs
              .readdirSync("/Volumes")
              .filter((fn) => fn.startsWith("fpcsrc"));
            var loc = fs
              .readdirSync("/Volumes/" + fpcsrc[0])
              .filter((fn) => fn.endsWith(".pkg"));
            if (loc === undefined || loc[0] === undefined) {
              loc = fs
                .readdirSync("/Volumes/" + fpcsrc[0])
                .filter((fn) => fn.endsWith(".mpkg"));
            }
            var full_path = "/Volumes/" + fpcsrc[0] + "/" + loc[0];
            await exec(`sudo installer -package ${full_path} -target /`);
          } else {
            // Install the package
            await exec(`sudo installer -package ${downloadPath_DAR} -target /`);
          }
        } catch (error) {
          throw error as Error;
        }

        // Get the URL for Free Pascal's compiler
        let downloadFPCURLDAR: string = this._getPackageURL("fpc");
        core.info(`_downloadLazarus - Downloading ${downloadFPCURLDAR}`);
        try {
          // Decide what the local download filename should be
          var downloadName = downloadFPCURLDAR.endsWith(".dmg")
            ? "fpc.dmg"
            : "fpc.pkg";

          if (cacheRestored) {
            // Use cached version
            downloadPath_DAR = path.join(
              this._getTempDirectory(),
              downloadName
            );
            core.info(
              `_downloadLazarus - Using cache restored into ${downloadPath_DAR}`
            );
          } else {
            // Perform the download
            downloadPath_DAR = await tc.downloadTool(
              downloadFPCURLDAR,
              path.join(this._getTempDirectory(), downloadName)
            );
            core.info(`_downloadLazarus - Downloaded into ${downloadPath_DAR}`);
          }

          // Download could be a pkg or dmg, handle either case
          if (downloadName == "fpc.dmg") {
            // Mount DMG and intall package
            await exec(`sudo hdiutil attach ${downloadPath_DAR}`);

            // There MUST be a better way to do this
            var fpc = fs
              .readdirSync("/Volumes")
              .filter((fn) => fn.startsWith("fpc"));
            var loc = fs
              .readdirSync("/Volumes/" + fpc[0])
              .filter((fn) => fn.endsWith(".pkg"));
            if (loc === undefined || loc[0] === undefined) {
              loc = fs
                .readdirSync("/Volumes/" + fpc[0])
                .filter((fn) => fn.endsWith(".mpkg"));
            }
            var full_path = "/Volumes/" + fpc[0] + "/" + loc[0];
            await exec(`sudo installer -package ${full_path} -target /`);
          } else {
            // Install the package
            await exec(`sudo installer -package ${downloadPath_DAR} -target /`);
          }
        } catch (error) {
          throw error as Error;
        }

        // Get the URL for the Lazarus IDE
        let downloadLazURLDAR: string = this._getPackageURL("laz");
        core.info(`_downloadLazarus - Downloading ${downloadLazURLDAR}`);
        try {
          // Decide what the local download filename should be
          var downloadName = downloadLazURLDAR.endsWith(".dmg")
            ? "lazarus.dmg"
            : "lazarus.pkg";

          if (cacheRestored) {
            // Use the cached version
            downloadPath_DAR = path.join(
              this._getTempDirectory(),
              downloadName
            );
            core.info(
              `_downloadLazarus - Using cache restored into ${downloadPath_DAR}`
            );
          } else {
            // Perform the download
            downloadPath_DAR = await tc.downloadTool(
              downloadLazURLDAR,
              path.join(this._getTempDirectory(), downloadName)
            );
            core.info(`_downloadLazarus - Downloaded into ${downloadPath_DAR}`);
          }

          // Download could be a pkg or dmg, handle either case
          if (downloadName == "lazarus.dmg") {
            // Mount DMG and intall package
            await exec(`sudo hdiutil attach ${downloadPath_DAR}`);

            // There MUST be a better way to do this
            var laz = fs
              .readdirSync("/Volumes")
              .filter((fn) => fn.startsWith("lazarus"));
            var loc = fs
              .readdirSync("/Volumes/" + laz[0])
              .filter((fn) => fn.endsWith(".pkg"));
            if (loc === undefined || loc[0] === undefined) {
              loc = fs
                .readdirSync("/Volumes/" + laz[0])
                .filter((fn) => fn.endsWith(".mpkg"));
            }
            var full_path = "/Volumes/" + laz[0] + "/" + loc[0];
            await exec(`sudo installer -package ${full_path} -target /`);
          } else {
            // Install the package
            await exec(`sudo installer -package ${downloadPath_DAR} -target /`);
          }
        } catch (error) {
          throw error as Error;
        }

        // For 2.0.10 and older, lazbuild symlink is /Library/Lazarus/lazbuild
        // For 2.0.12, lazbuild symlink is /Applications/Lazarus/lazbuild
        // Update the symlink to lazbuild
        const lazLibPath = "/Library/Lazarus/lazbuild";
        const lazAppPath = "/Applications/Lazarus/lazbuild";
        try {
          if (fs.existsSync(`${lazLibPath}`)) {
            core.info(
              `_downloadLazarus - Do not need to update lazbuild symlink`
            );
          } else if (fs.existsSync(`${lazAppPath}`)) {
            core.info(
              `_downloadLazarus - Updating lazbuild symlink to ${lazAppPath}`
            );
            // Remove bad symlink
            await exec(`rm -rf /usr/local/bin/lazbuild`);
            // Add good symlink
            await exec(`ln -s ${lazAppPath} /usr/local/bin/lazbuild`);
          } else {
            throw new Error(
              `Could not find lazbuild in ${lazLibPath} or ${lazAppPath}`
            );
          }
        } catch (error) {
          throw error as Error;
        }

        break;
      default:
        throw new Error(
          `_downloadLazarus - Platform not implemented: ${this._Platform}`
        );
    }
  }

  private _getPackageURL(pkg: string): string {
    let result: string = "";
    // Replace periods with undescores due to JSON borking with periods or dashes
    //let lazVer = "v" + this._LazarusVersion.replace(/\./gi, "_");
    switch (this._Platform) {
      case "win32":
        if (this._Arch == "x64") {
          result = `https://sourceforge.net/projects/lazarus/files/Lazarus%20Windows%2064%20bits/Lazarus%20${this._LazarusVersion}/`;
        } else {
          result = `https://sourceforge.net/projects/lazarus/files/Lazarus%20Windows%2032%20bits/Lazarus%20${this._LazarusVersion}/`;
        }
        result += createLazarusFileName(this._LazarusVersion);
        break;
      case "linux":
        result = `https://sourceforge.net/projects/lazarus/files/Lazarus%20Linux%20amd64%20DEB/Lazarus%20${this._LazarusVersion}/`;
        result += createLazarusFileName(this._LazarusVersion)[pkg];
        break;
      case "darwin":
        result = `https://sourceforge.net/projects/lazarus/files/Lazarus%20macOS%20x86-64/Lazarus%20${this._LazarusVersion}/`;
        result += createLazarusFileName(this._LazarusVersion)[pkg];
        break;
    }

    return result;
  }

  private _getTempDirectory(): string {
    let tempDirectory = process.env["RUNNER_TEMP"] || "";
    ok(tempDirectory, "Expected RUNNER_TEMP to be defined");
    tempDirectory = path.join(tempDirectory, "installers");
    return tempDirectory;
  }
}

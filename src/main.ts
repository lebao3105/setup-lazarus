import * as core from "@actions/core";
import * as inst from "./installer";

async function run(): Promise<void> {
  try {
    let Installer = new inst.Installer(
      core.getInput("lazarus-version"),
      core.getInput("include-packages").split(","),
      core.getInput("with-cache") == "true"
    );
    await Installer.install();
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

run();

export default run;

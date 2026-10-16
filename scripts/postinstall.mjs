import { extensionPath } from '../src/cli/extension-path.mjs';

console.log(`
Comm100 Auto Login installed.

Chrome extension folder:
${extensionPath()}

Open chrome://extensions, enable Developer mode, and click "Load unpacked".
Select the folder above, then run: comm100-accounts setup
Reload the extension once more after setup.

To print this path again: comm100-accounts extension-path
`);

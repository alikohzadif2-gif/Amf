// Expo config plugin (sharing track, stages 4-5): keeps the partner's pictures (`files/meyou-partner-media/`, incl. the outbox) and the
// private vault (`files/meyou-vault/`) out of Android's cloud backup and device-to-device transfer. Both are private to this phone.
//
// expo-secure-store already points the manifest at two rule files that exclude the SecureStore preferences (the E2E keys!).
// This plugin must never replace those rules, only ADD an <exclude> to them. It runs as a finalized mod (after every other
// mod) so it sees the final files; if the files do not exist it creates them (with the SecureStore exclusion too) and sets the
// manifest attributes. Everything here is idempotent and prints a warning instead of failing the build.
const fs = require('fs');
const path = require('path');

const FOLDER = 'meyou-partner-media';
const BACKUP_FILE = 'secure_store_backup_rules.xml';
const EXTRACTION_FILE = 'secure_store_data_extraction_rules.xml';
const VAULT_FOLDER = 'meyou-vault';
const EXCLUDE = `<exclude domain="file" path="${FOLDER}/"/>`;
const EXCLUDE_VAULT = `<exclude domain="file" path="${VAULT_FOLDER}/"/>`;
const EXCLUDES = [EXCLUDE, EXCLUDE_VAULT];

const backupRules = () => `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
  <exclude domain="sharedpref" path="SecureStore"/>
  ${EXCLUDE}
  ${EXCLUDE_VAULT}
</full-backup-content>
`;

const extractionRules = () => `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
    <exclude domain="sharedpref" path="SecureStore"/>
    ${EXCLUDE}
    ${EXCLUDE_VAULT}
  </cloud-backup>
  <device-transfer>
    <exclude domain="sharedpref" path="SecureStore"/>
    ${EXCLUDE}
    ${EXCLUDE_VAULT}
  </device-transfer>
</data-extraction-rules>
`;

/** Adds the exclusion to the end of `<full-backup-content>`. Null when the file is not in the expected shape. */
function patchBackup(xml) {
  if (!/<\/full-backup-content>/.test(xml)) return null;
  const missing = EXCLUDES.filter((line) => !xml.includes(line));
  if (missing.length === 0) return xml;
  return xml.replace(/<\/full-backup-content>/, `${missing.map((line) => `  ${line}\n`).join('')}</full-backup-content>`);
}

/** Adds the exclusion inside `<cloud-backup>` and `<device-transfer>` (created when missing). Null when not a rules file. */
function patchExtraction(xml) {
  if (!/<\/data-extraction-rules>/.test(xml)) return null;
  let out = xml;
  for (const section of ['cloud-backup', 'device-transfer']) {
    const block = out.match(new RegExp(`<${section}>[\\s\\S]*?</${section}>`));
    if (block) {
      const missing = EXCLUDES.filter((line) => !block[0].includes(line));
      if (missing.length === 0) continue;
      const close = new RegExp(`</${section}>`);
      out = out.replace(close, `${missing.map((line) => `  ${line}\n  `).join('')}</${section}>`);
    } else {
      out = out.replace(/<\/data-extraction-rules>/, `  <${section}>\n    <exclude domain="sharedpref" path="SecureStore"/>\n${EXCLUDES.map((line) => `    ${line}\n`).join('')}  </${section}>\n</data-extraction-rules>`);
    }
  }
  return out;
}

function writeOrPatch(file, patch, fresh) {
  if (fs.existsSync(file)) {
    const next = patch(fs.readFileSync(file, 'utf8'));
    if (next === null) console.warn(`[with-backup-exclude] ${path.basename(file)} has an unexpected shape; the partner pictures and the vault are NOT excluded from backup.`);
    else fs.writeFileSync(file, next);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh());
  }
}

module.exports = function withBackupExclude(config) {
  const { withAndroidManifest, withFinalizedMod } = require('expo/config-plugins'); // loaded here so the pure helpers below can be tested without Expo
  // Only sets the attributes when nothing set them yet (expo-secure-store normally does).
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:fullBackupContent'] ??= `@xml/${BACKUP_FILE.replace('.xml', '')}`;
      app.$['android:dataExtractionRules'] ??= `@xml/${EXTRACTION_FILE.replace('.xml', '')}`;
    }
    return cfg;
  });
  return withFinalizedMod(config, [
    'android',
    (cfg) => {
      const xml = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      writeOrPatch(path.join(xml, BACKUP_FILE), patchBackup, backupRules);
      writeOrPatch(path.join(xml, EXTRACTION_FILE), patchExtraction, extractionRules);
      return cfg;
    },
  ]);
};
module.exports.patchBackup = patchBackup;
module.exports.patchExtraction = patchExtraction;
module.exports.backupRules = backupRules;
module.exports.extractionRules = extractionRules;
module.exports.EXCLUDE = EXCLUDE;
module.exports.EXCLUDE_VAULT = EXCLUDE_VAULT;

// New names take precedence; old names remain valid for existing installs.
export const setting = (name) => process.env[`PUNK_RECORDS_${name}`] || process.env[`PREVIOUSLY_${name}`];

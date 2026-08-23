/**
 * Run a backup now, and say what happened.
 *
 * The nightly job is the one that matters; this exists so an owner can prove it
 * works without waiting until 03:20, and so a failure can be reproduced with
 * the full error in front of them rather than a log line.
 *
 * Exits explicitly: the backup pulls in the queue module, whose Redis handle
 * would otherwise hold the process open forever.
 */
const { runBackup } = require('../dist/modules/ops/backup.service');

runBackup()
  .then((result) => {
    const mb = (result.bytes / 1024 / 1024).toFixed(2);
    console.log('');
    console.log('  file      ' + result.file);
    console.log('  size      ' + mb + ' MB');
    console.log('  took      ' + (result.durationMs / 1000).toFixed(1) + 's');
    console.log('  restored  ' +
      result.verified.conversations + ' conversations, ' +
      result.verified.messages + ' messages, ' +
      result.verified.contacts + ' contacts');
    if (result.pruned.length) console.log('  pruned    ' + result.pruned.join(', '));
    console.log('');
    console.log('  Verified: this dump was restored into a scratch database and counted.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('');
    console.error('  BACKUP FAILED — do not trust the most recent dump.');
    console.error('  ' + String(error));
    process.exit(1);
  });

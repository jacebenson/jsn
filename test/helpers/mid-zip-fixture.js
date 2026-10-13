import fs from 'node:fs';
// Tiny standards-compliant stored ZIPs for disposable installer tests. No vendor
// runtime or network; content supplied by the test, never production credentials.
export function writeZip(filename, files) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, text = '', mode = 0o100600 } of files) {
    const bytes = Buffer.from(text), encoded = Buffer.from(name);
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ -1) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(encoded.length, 26);
    locals.push(local, encoded, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(encoded.length, 28);
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, encoded);
    offset += 30 + encoded.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(filename, Buffer.concat([...locals, directory, end]), { mode: 0o600 });
}
export const inertAgent = [
  { name: 'META-INF/MANIFEST.MF', text: 'Manifest-Version: 1.0\n' },
  { name: 'agent/config.xml', text: '<parameters><!-- <parameter name="name" value="example"/> --><parameter name="url" value="old"/><parameter name="mid.instance.username" value="old"/><parameter secure="true" name="mid.instance.password" value="old"/><parameter name="name" value="old"/><parameter name="threads.max" value="25"/></parameters>' },
  { name: 'agent/conf/wrapper-override.conf', text: 'wrapper.name=snc_mid\nwrapper.displayname=ServiceNow MID Server\n' },
  { name: 'agent/bin/mid.shconf_override', text: 'RUN_AS_USER=\nGROUP_NAME=\nPROMPT_BEFORE_OWNERSHIP_CHANGE=true\n' },
  { name: 'agent/bin/mid.sh', mode: 0o100755, text: '#!/bin/sh\ncase "$1" in start|stop) printf "%s\\n" "$1" >> ./invocations;; *) exit 2;; esac\n' },
  { name: 'agent/bin/mid.bat', text: '@echo off\necho isolated provider only\n' },
];

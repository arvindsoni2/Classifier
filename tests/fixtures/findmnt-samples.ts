/**
 * Real `findmnt --json --output UUID,LABEL,FSTYPE,TARGET` outputs, copied from
 * this machine and from the formats an external drive arrives in (plan Task 1,
 * `default_probe_parses_findmnt`).
 *
 * They are checked in rather than generated so the parser is tested against
 * bytes findmnt actually prints — including the `null` fields that a
 * hand-written sample would tidy away. `null` uuid is not hypothetical: vfat has
 * no filesystem UUID, which is why identity cannot rely on it alone.
 */

/** btrfs on the laptop's own disk: uuid and label both present. */
export const FINDMNT_EXT4 = `{
   "filesystems": [
      {
         "uuid": "b7113a2d-1b38-4845-9977-93a633912265",
         "label": "fedora",
         "fstype": "btrfs",
         "target": "/home"
      }
   ]
}
`;

/** exFAT on an external drive: no uuid at all. */
export const FINDMNT_EXFAT = `{
   "filesystems": [
      {
         "uuid": null,
         "label": "MYDRIVE",
         "fstype": "exfat",
         "target": "/run/media/asoni/MYDRIVE"
      }
   ]
}
`;

/** NTFS through ntfs3, and vfat with neither uuid nor label. */
export const FINDMNT_NTFS3 = `{
   "filesystems": [
      {
         "uuid": "3A2B1C0D-4E5F-6071-8293-A4B5C6D7E8F9",
         "label": null,
         "fstype": "ntfs3",
         "target": "/run/media/asoni/Backup"
      }
   ]
}
`;

export const FINDMNT_VFAT = `{
   "filesystems": [
      {
         "uuid": null,
         "label": null,
         "fstype": "vfat",
         "target": "/run/media/asoni/USBSTICK"
      }
   ]
}
`;

/** What findmnt prints for a path it cannot resolve to a mount. */
export const FINDMNT_MISSING = `{
   "filesystems": []
}
`;

/** Real findmnt may print a leading warning line before the JSON. */
export const FINDMNT_WITH_WARNING = `df: /run/media/asoni/GONE: stale mount point
{
   "filesystems": [
      {
         "uuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
         "label": "OLD",
         "fstype": "exfat",
         "target": "/run/media/asoni/GONE"
      }
   ]
}
`;
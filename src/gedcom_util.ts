import {
  JsonFam,
  JsonGedcomData,
  JsonIndi,
  gedcomEntriesToJson,
  JsonImage,
} from 'topola';
import {GedcomEntry, parse as parseGedcom} from 'parse-gedcom';

export interface GedcomData {
  /** The HEAD entry. */
  head: GedcomEntry;
  /** INDI entries mapped by id. */
  indis: {[key: string]: GedcomEntry};
  /** FAM entries mapped by id. */
  fams: {[key: string]: GedcomEntry};
  /** Other entries mapped by id, e.g. NOTE, SOUR. */
  other: {[key: string]: GedcomEntry};
}

export interface TopolaData {
  chartData: JsonGedcomData;
  gedcom: GedcomData;
}

/**
 * Returns the identifier extracted from a pointer string.
 * E.g. '@I123@' -> 'I123'
 */
export function pointerToId(pointer: string): string {
  return pointer.substring(1, pointer.length - 1);
}

function prepareGedcom(entries: GedcomEntry[]): GedcomData {
  const head = entries.find((entry) => entry.tag === 'HEAD')!;
  const indis: {[key: string]: GedcomEntry} = {};
  const fams: {[key: string]: GedcomEntry} = {};
  const other: {[key: string]: GedcomEntry} = {};
  entries.forEach((entry) => {
    if (entry.tag === 'INDI') {
      indis[pointerToId(entry.pointer)] = entry;
    } else if (entry.tag === 'FAM') {
      fams[pointerToId(entry.pointer)] = entry;
    } else if (entry.pointer) {
      other[pointerToId(entry.pointer)] = entry;
    }
  });
  return {head, indis, fams, other};
}

function strcmp(a: string, b: string) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** Birth date comparator for individuals. */
function birthDatesComparator(gedcom: JsonGedcomData) {
  const idToIndiMap = new Map<string, JsonIndi>();
  gedcom.indis.forEach((indi) => {
    idToIndiMap[indi.id] = indi;
  });

  return (indiId1: string, indiId2: string) => {
    const idComparison = strcmp(indiId1, indiId2);
    const indi1: JsonIndi = idToIndiMap[indiId1];
    const indi2: JsonIndi = idToIndiMap[indiId2];
    const birth1 = indi1 && indi1.birth;
    const birth2 = indi2 && indi2.birth;
    const date1 =
      birth1 && (birth1.date || (birth1.dateRange && birth1.dateRange.from));
    const date2 =
      birth2 && (birth2.date || (birth2.dateRange && birth2.dateRange.from));
    if (!date1 || !date1.year || !date2 || !date2.year) {
      return idComparison;
    }
    if (date1.year !== date2.year) {
      return date1.year - date2.year;
    }
    if (!date1.month || !date2.month) {
      return idComparison;
    }
    if (date1.month !== date2.month) {
      return date1.month - date2.month;
    }
    if (date1.day && date2.day && date1.day !== date2.day) {
      return date1.month - date2.month;
    }
    return idComparison;
  };
}

/**
 * Sorts children by birth date in the given family.
 * Does not modify the input objects.
 */
function sortFamilyChildren(
  fam: JsonFam,
  comparator: (id1: string, id2: string) => number,
): JsonFam {
  if (!fam.children) {
    return fam;
  }
  const newChildren = fam.children.sort(comparator);
  return Object.assign({}, fam, {children: newChildren});
}

/**
 * Sorts children by birth date.
 * Does not modify the input object.
 */
function sortChildren(gedcom: JsonGedcomData): JsonGedcomData {
  const comparator = birthDatesComparator(gedcom);
  const newFams = gedcom.fams.map((fam) => sortFamilyChildren(fam, comparator));
  return Object.assign({}, gedcom, {fams: newFams});
}

const IMAGE_EXTENSIONS = ['.jpg', '.png', '.gif'];

/** Returns true if the given file name has a known image extension. */
function isImageFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

/**
 * Removes images that are not HTTP links or do not have known image extensions.
 * Does not modify the input object.
 */
function filterImage(indi: JsonIndi, images: Map<string, string>): JsonIndi {
  if (!indi.images || indi.images.length === 0) {
    return indi;
  }
  const newImages: JsonImage[] = [];
  indi.images.forEach((image) => {
    const fileName = image.url.match(/[^/\\]*$/)![0];
    // If the image file has been loaded into memory, use it.
    if (images.has(fileName)) {
      newImages.push({url: images.get(fileName)!, title: image.title});
    } else if (image.url.startsWith('http') && isImageFile(image.url)) {
      newImages.push(image);
    }
  });
  return Object.assign({}, indi, {images: newImages});
}

/**
 * Removes images that are not HTTP links.
 * Does not modify the input object.
 */
function filterImages(
  gedcom: JsonGedcomData,
  images: Map<string, string>,
): JsonGedcomData {
  const newIndis = gedcom.indis.map((indi) => filterImage(indi, images));
  return Object.assign({}, gedcom, {indis: newIndis});
}

/**
 * Converts GEDCOM file into JSON data performing additional transformations:
 * - sort children by birth date
 * - remove images that are not HTTP links and aren't mapped in `images`.
 *
 * @param images Map from file name to image URL. This is used to pass in
 *   uploaded images.
 */
export function convertGedcom(
  gedcom: string,
  images: Map<string, string>,
): TopolaData {
  const entries = parseGedcom(gedcom);
  const json = gedcomEntriesToJson(entries);
  if (
    !json ||
    !json.indis ||
    !json.indis.length ||
    !json.fams ||
    !json.fams.length
  ) {
    throw new Error('Failed to read GEDCOM file');
  }

  return {
    chartData: filterImages(sortChildren(json), images),
    gedcom: prepareGedcom(entries),
  };
}

export function getSoftware(head: GedcomEntry): string | null {
  const sour =
    head && head.tree && head.tree.find((entry) => entry.tag === 'SOUR');
  const name =
    sour && sour.tree && sour.tree.find((entry) => entry.tag === 'NAME');
  return (name && name.data) || null;
}

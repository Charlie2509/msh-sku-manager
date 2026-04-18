const macronModelReferences = [
  {
    slug: "elbrus",
    displayName: "Elbrus",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "gyor",
    displayName: "Gyor",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "horn",
    displayName: "Horn",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "northland",
    displayName: "Northland",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "pepper",
    displayName: "Pepper",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "snow",
    displayName: "Snow",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "turvey",
    displayName: "Turvey",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "rookie",
    displayName: "Rookie",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "aulos",
    displayName: "Aulos",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "coldmire",
    displayName: "Coldmire",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "dance",
    displayName: "Dance",
    garmentType: "hoodie",
    allowedColours: [],
  },
  {
    slug: "barrier",
    displayName: "Barrier",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "anvik",
    displayName: "Anvik",
    garmentType: "unknown",
    allowedColours: [],
  },
  {
    slug: "round",
    displayName: "Round",
    garmentType: "unknown",
    allowedColours: [],
  },
];

export const macronReferenceMap = Object.fromEntries(
  macronModelReferences.map((reference) => [reference.slug.toLowerCase(), reference]),
);

export { macronModelReferences };

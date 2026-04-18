export const macronReferenceData = {
  elbrus: {
    slug: "elbrus",
    displayName: "Elbrus",
    garmentType: "showerjacket",
    allowedColours: [],
    aliases: [],
  },
  gyor: {
    slug: "gyor",
    displayName: "Gyor",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  horn: {
    slug: "horn",
    displayName: "Horn",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  northland: {
    slug: "northland",
    displayName: "Northland",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  pepper: {
    slug: "pepper",
    displayName: "Pepper",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  snow: {
    slug: "snow",
    displayName: "Snow",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  turvey: {
    slug: "turvey",
    displayName: "Turvey",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  rookie: {
    slug: "rookie",
    displayName: "Rookie",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  barrier: {
    slug: "barrier",
    displayName: "Barrier",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  anvik: {
    slug: "anvik",
    displayName: "Anvik",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  round: {
    slug: "round",
    displayName: "Round",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  aulos: {
    slug: "aulos",
    displayName: "Aulos",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  coldmire: {
    slug: "coldmire",
    displayName: "Coldmire",
    garmentType: "unknown",
    allowedColours: [],
    aliases: [],
  },
  dance: {
    slug: "dance",
    displayName: "Dance",
    garmentType: "hoodie",
    allowedColours: [],
    aliases: [],
  },
};

export const macronModelReferences = Object.values(macronReferenceData);

export const macronReferenceMap = Object.fromEntries(
  Object.entries(macronReferenceData).map(([slug, reference]) => [slug.toLowerCase(), reference]),
);

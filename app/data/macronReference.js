const CATALOGUE_PENDING_SOURCE = "catalogue-pending";
const CATALOGUE_VERIFIED_SOURCE = "catalogue-verified";

const createReferenceEntry = ({
  slug,
  displayName,
  garmentType,
  allowedColours,
  aliases,
  source,
}) => ({
  slug,
  displayName,
  garmentType,
  allowedColours,
  aliases,
  source,
});

const createPendingReference = ({
  slug,
  displayName,
  garmentType = "unknown",
  aliases = [],
}) =>
  createReferenceEntry({
    slug,
    displayName,
    garmentType,
    allowedColours: [],
    aliases,
    source: CATALOGUE_PENDING_SOURCE,
  });

export const macronReferenceData = {
  elbrus: createPendingReference({
    slug: "elbrus",
    displayName: "Elbrus",
    garmentType: "showerjacket",
    aliases: [],
  }),
  gyor: createPendingReference({
    slug: "gyor",
    displayName: "Gyor",
    garmentType: "unknown",
    aliases: [],
  }),
  horn: createPendingReference({
    slug: "horn",
    displayName: "Horn",
    garmentType: "unknown",
    aliases: [],
  }),
  northland: createPendingReference({
    slug: "northland",
    displayName: "Northland",
    garmentType: "unknown",
    aliases: [],
  }),
  pepper: createPendingReference({
    slug: "pepper",
    displayName: "Pepper",
    garmentType: "unknown",
    aliases: [],
  }),
  snow: createPendingReference({
    slug: "snow",
    displayName: "Snow",
    garmentType: "unknown",
    aliases: [],
  }),
  turvey: createPendingReference({
    slug: "turvey",
    displayName: "Turvey",
    garmentType: "unknown",
    aliases: [],
  }),
  rookie: createPendingReference({
    slug: "rookie",
    displayName: "Rookie",
    garmentType: "unknown",
    aliases: [],
  }),
  barrier: createPendingReference({
    slug: "barrier",
    displayName: "Barrier",
    garmentType: "unknown",
    aliases: [],
  }),
  anvik: createPendingReference({
    slug: "anvik",
    displayName: "Anvik",
    garmentType: "unknown",
    aliases: [],
  }),
  round: createPendingReference({
    slug: "round",
    displayName: "Round",
    garmentType: "unknown",
    aliases: [],
  }),
  aulos: createPendingReference({
    slug: "aulos",
    displayName: "Aulos",
    garmentType: "unknown",
    aliases: [],
  }),
  coldmire: createPendingReference({
    slug: "coldmire",
    displayName: "Coldmire",
    garmentType: "unknown",
    aliases: [],
  }),
  dance: createPendingReference({
    slug: "dance",
    displayName: "Dance",
    garmentType: "hoodie",
    aliases: [],
  }),
};

export const macronModelReferences = Object.values(macronReferenceData);

export const macronReferenceMap = Object.fromEntries(
  Object.entries(macronReferenceData).map(([slug, reference]) => [slug.toLowerCase(), reference]),
);

export { CATALOGUE_PENDING_SOURCE, CATALOGUE_VERIFIED_SOURCE };

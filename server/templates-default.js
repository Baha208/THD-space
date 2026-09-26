/* ===== THD Space server — default project templates =====
   Seeded into the bucket (templates.json) the first time templates are read, then edited in the
   admin panel. A template is only a starting shape: floors with their rooms and no images. Room
   names are a first guess for THD's vocabulary; edit them in the panel, not here. */

export const DEFAULT_TEMPLATES = [
  {
    id: "villa",
    name: "Villa",
    description: "Ground, first and roof levels with landscape",
    floors: [
      { label: "Ground Floor", tabLabel: "Ground",
        rooms: ["Reception", "Living Room", "Dining Room", "Kitchen", "Guest Toilet", "Landscape"] },
      { label: "First Floor", tabLabel: "First",
        rooms: ["Master Bedroom", "Master Bathroom", "Bedroom 1", "Bedroom 2", "Family Bathroom", "Lobby"] },
      { label: "Roof Floor", tabLabel: "Roof",
        rooms: ["Roof Lounge", "Roof Bathroom", "Outdoor"] }
    ]
  },
  {
    id: "apartment",
    name: "Apartment",
    description: "One level",
    floors: [
      { label: "Apartment", tabLabel: "Plan",
        rooms: ["Reception", "Living Room", "Dining Room", "Kitchen", "Master Bedroom", "Master Bathroom", "Bedroom", "Bathroom", "Guest Toilet"] }
    ]
  },
  {
    id: "duplex",
    name: "Duplex",
    description: "Lower and upper levels",
    floors: [
      { label: "Lower Level", tabLabel: "Lower",
        rooms: ["Reception", "Living Room", "Dining Room", "Kitchen", "Guest Toilet"] },
      { label: "Upper Level", tabLabel: "Upper",
        rooms: ["Master Bedroom", "Master Bathroom", "Bedroom", "Bathroom", "Lobby"] }
    ]
  },
  {
    id: "blank",
    name: "Blank",
    description: "One empty floor; add rooms yourself",
    floors: [
      { label: "Ground Floor", tabLabel: "Ground", rooms: [] }
    ]
  }
];

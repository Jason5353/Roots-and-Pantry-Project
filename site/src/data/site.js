// One place for facts used across the public site.
export const site = {
  name: 'Roots & Pantry',
  email: 'hello@rootsandpantry.co.uk',
  demo: 'https://roots-and-pantry-demo.pages.dev/',
  demoProducers: 'https://roots-and-pantry-demo.pages.dev/producers/',
  company: 'BMS Cyber Defence Ltd',
  companyNumber: '14975379',
  companyUrl: 'https://bmscyberdefence.co.uk/',
  // Only shown on the Privacy & Terms page.
  address: '254 Holyhead Road, Wellington, Telford, TF1 2EB',
  phone: '+44 7821 453905',
  phoneHref: 'tel:+447821453905',
  // The app. Cloudflare Pages preview builds set PUBLIC_APP_URL to the test app.
  app: import.meta.env.PUBLIC_APP_URL || 'https://app.rootsandpantry.co.uk',
  // Stage 1: the family app isn't open yet.
  familyOpen: false,
  producerSignupOpen: true,
};

export const mail = (subject) => `mailto:${site.email}?subject=${encodeURIComponent(subject)}`;

export const contact = (topic) => `${site.app}/contact${topic ? `?topic=${encodeURIComponent(topic)}` : ''}`;

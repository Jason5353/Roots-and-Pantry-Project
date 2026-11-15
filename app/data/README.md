# Postcode districts

`postcode-districts.csv`: centre point of each UK postcode district (outcode), with a nearby town.
From https://github.com/Gibbs/uk-postcodes (CC0 1.0, public domain), last updated 2017. 2,856 districts.
A handful of districts created since 2017 are missing; the directory then asks for a nearby district or county.

`node scripts/make-districts.mjs` turns it into `migrations/0005_districts.sql`. To refresh the data,
write a new migration (e.g. `DELETE FROM postcode_districts;` then fresh inserts) instead of editing 0005.

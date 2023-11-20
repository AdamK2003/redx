# RedX

Public instance (this fork): https://redx.adamski2003.lol/
Public instance (original): https://redx.cloudns.org/

Modified facet: `resrec:///U-AdamSkI2003/R-7AC884DF712F5F78E4D089C995C8B7171BC6F21CA975EE37F3D3900CA82F886E`

RedX is a Resonite public folder/item indexer and search engine.

## Run it yourself

(This documentation applies to this fork; the original uses Elasticsearch and the setup steps are different.)

### Requirements

- NodeJS Gallium (16)
- A Meilisearch 1.3 deployment (1.4 probably won't work) and an API key with enough access to search, add and delete documents, and also create indexes and change index settings if you want to use the init script.

### Setup

1. Clone this repository, run `npm i` to install dependencies. (Make sure you're running NodeJS 16 before doing this, otherwise the dependency install might fail)
2. Copy `.env.example` to `.env` and fill in the required values.
3. `cd` to the `redx-frontend` directory, run `npm i` to install dependencies and `npm run build` to build the frontend.
4. Set up the Meilisearch indexes. You can just run `npm run init` in the root directory and it'll do everything for you.

- If you want to do it manually: create 2 indexes named `redx-records-res` and `redx-pending-records-res` with the primary key set to `id` and set the settings for both of them (you can add more filterable/sortable/searchable attributes if you want to):

- Filterable attributes:
  ```json
  [
    "id",
    "isDeleted",
    "isForPatrons",
    "isListed",
    "isPublic",
    "name",
    "objectType",
    "ownerId",
    "ownerName",
    "path",
    "recordType",
    "tags",
    "version"
  ]
  ```
- Sortable attributes:
  ```json
  ["lastModificationTime", "creationTime"]
  ```
- Searchable attributes (not mandatory, but recommended for quicker indexing):
  ```json
  [
    "pathNameSearchable",
    "ownerPathNameSearchable",
    "tagsSearchable",
    "name",
    "simpleName",
    "recordType",
    "ownerName",
    "tags",
    "path"
  ]
  ```
- Tune the ranking rules to your liking. The default ones are mostly fine, though you may want to add a sort rule on the modification/creation time in the last position.

5. `cd` back to the root directory and run `npm run server` to start the server. (You won't see any items in the frontend until you run the spider for the first time.) You can use a systemd service or a process manager like PM2 to keep the server running in the background and run it on system startup.
6. Run the spider with `npm run spider`. This will take a while to finish, but you should see items appearing in the frontend as they're indexed. You can use a cronjob to run this on a schedule.

![](doc/red.jpg)

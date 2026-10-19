/** Locale-neutral API fallback text. UI translations are owned by the presentation layer. */
export const errorFallbacks = {
  BACKUP_INVALID_SIZE: 'Backup archive size is invalid.',
  CONVERSATION_ID_CONFLICT: 'The destination chat ID is already in use. Try again.',

  IMAGE_UNSUPPORTED:
    'The selected model does not support images. Choose a vision model or adjust its capabilities.',
  REQUEST_FAILED: 'Request failed. Try again.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Try again later.',
  AUTH_REQUIRED: 'Sign in again to continue.',
  AUTH_UNAVAILABLE: 'Restore your connection and verify your identity first.',
  ACCESS_DENIED: 'This identity cannot access this workspace.',
  ACCESS_INVALID: 'Access is not configured correctly. Contact the administrator.',
  UNTRUSTED_ORIGIN: 'This request origin is not trusted.',
  NOT_FOUND: 'This item is unavailable or has been deleted.',
  INVALID_REQUEST: 'The request is invalid. Check your input and try again.',
  REQUEST_TOO_LARGE: 'This request exceeds the storage safety limit. Reduce its size.',
  REQUEST_TIMEOUT: 'The request timed out. Check your connection and try again.',
  INVALID_RESPONSE: 'The service response is invalid. Sync again.',
  LOCAL_CLEAR_FAILED: 'Some local records could not be cleared. Try again.',
  STORAGE_FULL: 'Cloud storage is full. Free up space or start a new chat.',
  SCHEMA_MISMATCH: 'The database needs an offline maintenance migration.',
  CONVERSATION_DELETED: 'This chat was deleted.',
  CONVERSATION_BUSY: 'Wait for generation to finish or stop it first.',
  MESSAGE_LIMIT: 'The message and reasoning exceed the 768 KiB storage safety limit.',
  BRANCH_INVALID: 'This message branch is invalid or unavailable. Sync the chat again.',
  PARENT_UNAVAILABLE: 'The parent message is unavailable. Select another branch and retry.',
  CONTEXT_INVALID:
    'The context cannot fit within the configured budget. Shorten the input or history, or adjust the budget.',
  CONTEXT_BUDGET_EXCEEDED:
    'Input needs about {{estimatedTokens}} tokens; the context budget is {{budgetTokens}}. Shorten the input or adjust the budget.',
  OUTPUT_BUDGET_EXCEEDED: 'The output budget cannot exceed {{limit}} tokens for this model.',
  TEMPERATURE_EXCEEDED: 'Temperature cannot exceed {{limit}} for this model.',
  TOP_P_BELOW_MINIMUM: 'Top P cannot be below {{limit}} for this model.',
  SAMPLING_CONFLICT: 'Set either Temperature or Top P for this model.',
  SUMMARY_REQUIRED: 'Enable history summaries before using automatic compression.',
  SUMMARY_INVALID: 'Choose completed history within the summary model’s context window.',
  SUMMARY_FAILED:
    'The summary could not be completed. Original history is kept. Adjust the configuration and retry.',
  COMPRESSION_MODEL_UNAVAILABLE:
    'Enable the selected compression model or turn off automatic compression.',
  MODEL_UNAVAILABLE: 'Configure a provider and enable the selected model.',
  MODEL_UNSUPPORTED:
    'This model does not support the selected capability. Choose another model or adjust its capabilities.',
  MODEL_TOOLS_UNSUPPORTED:
    'This model does not support tool calls. Choose another model or adjust its capabilities.',
  MODEL_LIST_LIMIT:
    'The model list exceeds {{limit}} models. Split providers or add the models you need manually.',
  PROVIDER_INVALID:
    'Check the provider name, endpoint, model IDs, positive integer token limits and capabilities.',
  PROVIDER_URL_INVALID:
    'Enter a valid HTTPS API base URL without credentials, query, fragment or a specific API path.',
  PROVIDER_NAME_REQUIRED: 'Enter a nonempty provider name.',
  PROVIDER_KEY_REQUIRED: 'Configure the provider API key first.',
  PROVIDER_KEY_INVALID: 'The API key cannot contain line breaks.',
  PROVIDER_CONNECTION_FAILED:
    'Could not connect to the provider. Check its endpoint and your connection.',
  PROVIDER_CATALOG_INVALID:
    'The provider model catalog is invalid or exceeds the fetch limit. Add the models you need manually.',
  PROVIDER_FAILED:
    'The provider could not complete the answer. Saved content is kept; check the error details and retry.',
  PROVIDER_HTTP_ERROR: 'The provider returned HTTP {{status}}. Check the error details.',
  PROVIDER_RATE_LIMITED: 'The provider limited the request. Try again later.',
  PROVIDER_UNAUTHORIZED: 'The provider denied access. Check the API key and permissions.',
  PROVIDER_MODEL_NOT_FOUND: 'The provider could not find this model or endpoint.',
  STREAM_INVALID:
    'The provider stream was invalid or interrupted. Saved content is kept. Regenerate to retry.',
  GENERATION_INTERRUPTED:
    'Generation was interrupted. The latest checkpoint is kept. Regenerate to retry without duplicating a request.',
  TOOL_INVALID:
    'The tool call or continuation is invalid. Saved content is kept; regenerate to retry.',
  TOOL_FAILED: 'The web tool could not complete this request. Try another source or retry later.',
  TOOL_NOT_CONFIGURED: 'Configure the web tool service first.',
  TOOL_RATE_LIMITED: 'The web service request or daily quota has been reached. Try again later.',
  TOOL_UNAUTHORIZED: 'The web service denied access. Check its key and permissions.',
  TOOL_TIMEOUT: 'The web tool was stopped or timed out. Try again later.',
  TOOL_URL_INVALID: 'Only public HTTPS web addresses are allowed.',
  PRICING_INVALID: 'Enter a valid model price.',
  USAGE_INVALID: 'The usage filter or cursor is invalid. Refresh and try again.',
  SHARE_UNAVAILABLE: 'This share link is unavailable or has expired.',
  SHARE_PREVIEW_STALE: 'The chat or preview changed. Preview again before sharing.',
  SHARE_INCOMPLETE: 'Wait for this branch to finish or select a completed answer to share.',
  SHARE_EXPIRY_INVALID: 'Choose a valid expiry time in the future.',
  SEARCH_STALE: 'Search data changed or the cursor expired. Search again.',
  PRESET_INVALID:
    'Preset names must be 1–100 characters and system prompts at most 20,000 characters.',
  PRESET_LIMIT: 'The preset count or storage limit has been reached. Remove unused presets.',
  DEFAULT_PRESET_IMMUTABLE: 'The default preset cannot be renamed or deleted.',
  TITLE_FAILED: 'Title generation failed. The original title is kept. Try again.',
  TITLE_BUSY: 'The title was changed or is already being generated. Refresh before retrying.',
  BACKUP_INVALID: 'The backup is invalid or incomplete. Use a complete supported EverChat backup.',
  BACKUP_LIMIT:
    'The backup exceeds the safety limit. Export a smaller branch or use a ZIP archive for attachments.',
  IMPORT_FAILED: 'Restore was interrupted or could not finish. Import the archive again.',
  COPY_FAILED: 'The chat could not be copied. Check its branch and attachments, then retry.',
  OPERATION_BUSY:
    'This operation is busy or the recent request limit has been reached. Try again later.',
  ATTACHMENT_UNAVAILABLE:
    'The attachment is unavailable or incomplete. Select and upload the file again.',
  ATTACHMENT_IN_USE:
    'This file is still used by a message or generation. Remove the reference before deleting it.',
  ATTACHMENT_STORAGE_REQUIRED: 'Private attachment storage is not configured.',
  ATTACHMENT_LIMIT:
    'The attachment count or storage limit has been reached. Remove files or use a smaller selection.',
  ATTACHMENT_INVALID:
    'The file type, content or integrity check is invalid. Select the file again.',
  TEXT_INVALID: 'Use a UTF-8 text file with readable content and consistent CSV columns.',
  PDF_INVALID: 'The extracted PDF text or page index is invalid. Select and extract the PDF again.',
  PDF_SELECTION_INVALID: 'Enter page ranges such as 1–3, 5 within this PDF’s page count.',
  PDF_SELECTION_RANGE: 'Choose pages from 1 to {{limit}}.',
  NOTIFICATION_INVALID:
    'This notification subscription is invalid. Update the app and enable notifications again.',
} as const;

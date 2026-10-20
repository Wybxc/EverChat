import { FileText, ImageIcon } from 'lucide-react';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
import { Progress } from '@/components/ui/progress';
import { useTranslation } from 'react-i18next';

export function AttachmentUpload({
  progress,
  cancel,
}: {
  progress: {
    name: string;
    percent: number;
    kind: 'image' | 'file';
    state: 'processing' | 'uploading';
  };
  cancel: () => void;
}) {
  const { t } = useTranslation('app');
  return (
    <Attachment state={progress.state} size="sm" className="w-full" role="status">
      <AttachmentMedia>{progress.kind === 'image' ? <ImageIcon /> : <FileText />}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle title={progress.name}>{progress.name}</AttachmentTitle>
        <Progress
          value={progress.percent}
          className="mt-1"
          aria-label={
            progress.kind === 'image'
              ? t(($) => $.imageUploadProgress)
              : t(($) => $.fileUploadProgress)
          }
        />
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction size="sm" onClick={cancel}>
          {t(($) => $.cancelUpload)}
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}

import FileUploaderView from "./components/templates/fileUploaderView/fileUploader.view";

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans text-black">
      <FileUploaderView />
    </div>
  );
}

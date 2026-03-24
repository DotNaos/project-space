import { create } from 'zustand';

interface ProjectSpacesPickerState {
  query: string;
  setQuery(query: string): void;
}

export const useProjectSpacesPickerStore = create<ProjectSpacesPickerState>((set) => ({
  query: '',
  setQuery(query) {
    set({ query });
  }
}));
